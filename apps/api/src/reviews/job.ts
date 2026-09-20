/**
 * 评价同步的定时任务（05-AI-INTEGRATION §8.2）
 *
 * ## 为什么用最土的 setInterval
 *
 * 和通话对账（telnyx/schedule.ts）同一条理由：重复执行是安全的。
 * 「一家店一个平台同时只能有一次进行中的采集」由 `review_sync_runs` 上的
 * 唯一索引保证，两台机器同时跑，第二台会在占位那一步失败，一分钱都不会多花。
 * 状态既然已经在数据库里，就不值得为它引一个调度器（宪法第 10 条：不自管状态）。
 *
 * ## ⚠️ 默认关闭
 *
 * `REVIEW_SYNC_INTERVAL_MINUTES` 不设或为 0 时整个任务不启动。按 05 §8 的
 * 上线顺序：先用 staging 的手动入口验证一遍完整链路，确认抓到的正文、
 * 去重和费用都对得上，再打开定时任务。这条链路每一轮都真花钱，
 * 不该在没人看过一眼结果之前自己跑起来。
 *
 * ## 一家店失败不影响其余
 *
 * 每家店的处理都单独 try。抓取失败、模型超时、门店配置写错 —— 这些都是
 * 单店问题，让它们中断整轮会把一个小故障放大成「今天所有店都没同步」。
 */

import type { FastifyInstance, FastifyBaseLogger } from 'fastify';
import { listReviewSyncDue } from '@gf/db';
import type { CommandContext, Locale, Permission } from '@gf/contracts';
import { advanceReviewSync, type SyncOutcome } from './sync';
import { analyzeNewReviews, generateReviewSummary } from './analyze';
import { refreshGoogleStats } from './stats';
import { reviewSyncSettings } from './config';

/**
 * 后台任务的权限集合。
 *
 * 只给这条链路真正用得到的两项：写评价与摘要走 `report.view`，
 * 记模型用量走 `ai.use`。系统上下文的权限是代码写死的，不是从谁的账号继承的 ——
 * 越窄越好，多给一项就等于多一条「后台任务能做而人做不到」的路径。
 */
const SYNC_PERMISSIONS: readonly Permission[] = ['report.view', 'ai.use'];

/** 后台任务没有登录用户。和通话对账用同一个占位 uuid。 */
const SYSTEM_USER = '00000000-0000-4000-8000-000000000000';

export interface ReviewSyncRoundResult {
  scanned: number;
  triggered: number;
  ingested: number;
  failed: number;
  summarized: number;
}

export async function runReviewSyncRound(args: {
  limit?: number;
  log?: FastifyBaseLogger;
} = {}): Promise<ReviewSyncRoundResult> {
  const out: ReviewSyncRoundResult = {
    scanned: 0, triggered: 0, ingested: 0, failed: 0, summarized: 0,
  };

  const due = await listReviewSyncDue({
    staleMinutes: reviewSyncSettings.staleMinutes(),
    limit: args.limit ?? reviewSyncSettings.batchSize(),
  });
  out.scanned = due.length;

  for (const item of due) {
    const ctx: CommandContext = {
      orgId: item.orgId,
      locationId: item.locationId,
      userId: SYSTEM_USER,
      membershipId: null,
      permissions: new Set(SYNC_PERMISSIONS),
      actorKind: 'api',
      locale: (item.locale as Locale) ?? 'en',
      timezone: item.timezone,
    };

    try {
      /*
       * 平台权威评分只在**开新一轮**时刷新，不在每次轮询时刷。
       *
       * 轮询的间隔是分钟级的，而 Google Places 的详情接口按次计费、
       * Yelp Fusion 有每日配额 —— 跟着轮询刷会在一天里打出几百次
       * 完全一样的查询。分数一天变不了几次，跟着采集节奏走就够了。
       */
      if (item.reason === 'start' && item.platform === 'google') {
        const stats = await refreshGoogleStats(ctx);
        if (stats.state === 'failed') {
          args.log?.warn(
            { locationId: item.locationId, platform: item.platform, error: stats.error },
            'review stats refresh failed');
        }
      }

      const outcome: SyncOutcome = await advanceReviewSync(ctx, item.platform);
      if (outcome.state === 'started') out.triggered++;
      if (outcome.state === 'failed' || outcome.state === 'timed_out') {
        out.failed++;
        args.log?.warn(
          { locationId: item.locationId, platform: item.platform, error: outcome.error },
          'review sync failed');
      }
      if (outcome.state !== 'ingested') continue;

      out.ingested++;

      /*
       * 只有真的写进了新评价才调模型。
       *
       * 抓取跑完但一条新评价都没有是**常态**（门店评价的更新频率很低），
       * 这时候调模型等于为一份没有任何变化的输入付费。
       */
      if (outcome.inserted === 0) continue;

      await analyzeNewReviews(ctx, { log: args.log });
      const summary = await generateReviewSummary(ctx, { log: args.log });
      if (summary.state === 'generated') out.summarized++;
    } catch (e) {
      out.failed++;
      // 单店失败只记日志。中断整轮会把一个小故障放大成「今天所有店都没同步」
      args.log?.warn(
        { err: e, locationId: item.locationId, platform: item.platform },
        'review sync round item failed');
    }
  }

  return out;
}

/**
 * 挂上定时任务。
 *
 * ⚠️ 只在真正的入口调（`main.ts`）—— `buildServer()` 在测试里会被建很多次，
 * 每次都挂一个定时器的话，一跑测试就是几十个后台任务在同时抓取。
 * 和 `startCallReconciler` / `startRetentionJob` 同一条纪律。
 */
export function startReviewSyncJob(app: FastifyInstance): void {
  const minutes = Number(process.env['REVIEW_SYNC_INTERVAL_MINUTES'] ?? 0);
  if (!Number.isFinite(minutes) || minutes <= 0) return;

  const run = () => {
    void runReviewSyncRound({ log: app.log })
      .then((result) => {
        // 处理了 0 家也记一句：这条日志的用途是回答「同步到底有没有在跑」，
        // 只在有结果时才记的话，那个问题就没有答案了
        app.log.info(result, 'review sync round');
      })
      .catch((e) => app.log.error({ err: e }, 'review sync round failed'));
  };

  const timer = setInterval(run, minutes * 60_000);
  timer.unref();
  app.addHook('onClose', async () => clearInterval(timer));

  app.log.info({ minutes }, '评价同步定时任务已开启');
  // 起来之后先跑一轮，但要等服务稳定：刚部署完那一段最容易漏
  setTimeout(run, 30_000).unref();
}
