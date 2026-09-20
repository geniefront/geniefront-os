/**
 * 口碑聚合与 AI Review 总结路由
 *
 * 从 server.ts 拆出。包含：
 * - 评价摘要与分析 (/v1/desk/reviews/summary, /v1/desk/analytics/reviews-summary)
 * - 采集配置 (/v1/desk/reviews/sources)
 * - 手动同步与同步日志 (/v1/desk/reviews/sync, /v1/desk/reviews/sync-runs)
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError, ERROR_CODES } from '@gf/contracts';
import { withTenant } from '@gf/db';
import { loadReviewsSummary, loadReviewSources, loadReviewSyncRuns } from '../queries/reviews';
import { syncReviewsNow } from '../reviews/sync';
import { analyzeNewReviews, generateReviewSummary } from '../reviews/analyze';
import { refreshGoogleStats } from '../reviews/stats';
import { manualSyncEnabled } from '../reviews/config';
import { dispatch } from '../bus';
import type { CtxFromHeaders } from './utils';

/** 手动同步最多在请求里等这么久，超过就返回「还在跑」让调用方稍后再看 */
const MANUAL_WAIT_MS = 45_000;

export function registerReviewsRoutes(app: FastifyInstance, ctxFromHeaders: CtxFromHeaders): void {
  const handleReviewsSummary = async (req: FastifyRequest) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('report.view') && !ctx.permissions.has('ticket.read')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'report.view' } });
    }
    return withTenant(ctx, (tx) => loadReviewsSummary(tx, ctx));
  };
  app.get('/v1/desk/reviews/summary', handleReviewsSummary);
  app.get('/v1/desk/analytics/reviews-summary', handleReviewsSummary);

  // ── 采集配置 ─────────────────────────────────────────────────────────────

  app.get('/v1/desk/reviews/sources', async (req) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('settings.manage')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'settings.manage' } });
    }
    return withTenant(ctx, (tx) => loadReviewSources(tx, ctx, manualSyncEnabled()));
  });

  app.put<{ Body: Record<string, unknown> }>('/v1/desk/reviews/sources', async (req) => {
    const ctx = await ctxFromHeaders(req);
    const res = await dispatch('location.configureReviewSources', req.body, ctx);
    return res.result;
  });

  // ── 同步日志 ─────────────────────────────────────────────────────────────

  /**
   * 采集失败在老板端表现为「最近没有新评价」，与真的没人写评价无法区分。
   * 这个接口是把两者分开的唯一手段，因此它属于排障工具而不是业务数据 ——
   * 权限跟着 `settings.manage` 走。
   */
  app.get<{ Querystring: { limit?: string } }>('/v1/desk/reviews/sync-runs', async (req) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('settings.manage')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'settings.manage' } });
    }
    const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? '20') || 20));
    return withTenant(ctx, (tx) => loadReviewSyncRuns(tx, ctx, limit));
  });

  /**
   * ⚠️ 手动同步：**这个接口会立刻产生抓取费用**（Bright Data 按记录条数计费），
   * 并且可能接着调模型。它的用途是上线前在 staging 上把整条链路走一遍 ——
   * 看抓到的正文对不对、去重有没有生效、费用是不是预期的量级。
   *
   * 生产默认关闭（`REVIEW_SYNC_MANUAL_ENABLED`）。定时任务验证通过之后再开。
   */
  app.post<{ Body: { platform?: string; analyze?: boolean } }>(
    '/v1/desk/reviews/sync', async (req, reply) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('settings.manage')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'settings.manage' } });
    }
    if (!manualSyncEnabled()) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, {
        details: { reason: 'manual_review_sync_disabled' },
      });
    }

    const requested = req.body?.platform;
    if (requested !== undefined && requested !== 'google' && requested !== 'yelp') {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
        details: { reason: 'platform 只能是 google 或 yelp' },
      });
    }
    const platforms: Array<'google' | 'yelp'> = requested ? [requested] : ['google', 'yelp'];

    // Google 评分先刷新；Yelp 评分随 Bright Data 快照写入。
    const stats = [];
    for (const platform of platforms) {
      if (platform === 'google') stats.push(await refreshGoogleStats(ctx));
    }

    const sync = [];
    for (const platform of platforms) {
      sync.push(await syncReviewsNow(ctx, platform, { waitMs: MANUAL_WAIT_MS }));
    }

    // 抓到了新评价才跑模型。默认跑 —— 手动同步的用途正是验证整条链路，
    // 只抓不分析验证不到 §8.3 那一半
    const wantAnalysis = req.body?.analyze !== false;
    const insertedTotal = sync.reduce((sum, item) => sum + item.inserted, 0);
    const analysis = wantAnalysis && insertedTotal > 0
      ? await analyzeNewReviews(ctx, { log: req.log })
      : null;
    const summary = wantAnalysis && insertedTotal > 0
      ? await generateReviewSummary(ctx, { log: req.log })
      : null;

    reply.code(200);
    return { stats, sync, analysis, summary };
  });
}
