/**
 * 外部评价采集的状态机（05-AI-INTEGRATION §8.1）
 *
 * ## 为什么是状态机而不是「抓一次」
 *
 * Bright Data 的采集是异步的：触发只返回一个 `snapshotId`，结果要在数十秒到
 * 数分钟后另行下载。因此一次同步天然横跨多个进程生命周期，中间状态必须落在
 * `review_sync_runs` 上，由**每一轮调用推进一步**：
 *
 *   没有进行中的采集 → 触发 → running
 *   running          → 查进度 → 未就绪就原样返回，就绪则下载、入库、收尾
 *   running 超时     → 标失败（否则唯一索引会把这家店永久堵死）
 *
 * 每一次调用只推进一步，这样定时任务、staging 手动入口、失败重试走的是
 * **同一条代码路径** —— 不存在「手动那条路有个 bug 但定时那条没有」。
 *
 * ## 写库一律走命令总线
 *
 * 这个文件里没有任何 SQL 写入。审计、租户事务、欠费冻结不能因为
 * 「这是后台任务」被绕过（宪法第 1 条 / lint-guards 第 9 条）。
 */

import {
  fetchSnapshot, googleReviewsUrl, mapReviews, snapshotProgress, triggerSnapshot,
  yelpReviewsUrl, extractPlatformStats,
} from '@gf/brightdata';
import { parseTs, withTenant } from '@gf/db';
import type { CommandContext } from '@gf/contracts';
import { dispatch } from '../bus';
import { brightDataConfig, reviewSyncSettings } from './config';
import '../handlers/reviews';

export type ReviewPlatform = 'google' | 'yelp';

/**
 * 一次推进的结果。
 *
 * 每一种都是**可区分的**状态而不是布尔成败：调用方（定时任务的日志、
 * staging 的手动入口）需要把「这家店没配」「还在跑」「跑完了没有新评价」
 * 分开显示 —— 它们在老板端看起来都是「没有新评价」，而处置完全不同。
 */
export type SyncState =
  | 'not_configured'    // 门店没填这个平台的标识
  | 'disabled'          // 没有 Bright Data 凭据
  | 'throttled'         // 距上次采集还不够久
  | 'started'           // 刚触发，等结果
  | 'running'           // 上一次触发还在跑
  | 'ingested'          // 下载并写库完成
  | 'timed_out'         // 卡太久，已标失败以便下一轮重来
  | 'failed';

export interface SyncOutcome {
  platform: ReviewPlatform;
  state: SyncState;
  runId: string | null;
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
  costMillicents: number;
  error: string | null;
}

const empty = (platform: ReviewPlatform, state: SyncState): SyncOutcome => ({
  platform, state, runId: null,
  fetched: 0, inserted: 0, updated: 0, skipped: 0, costMillicents: 0, error: null,
});

interface ActiveRun {
  id: string;
  snapshotId: string | null;
  requestedAt: string;
}

interface SourceRow {
  yelp_business_id: string | null;
  google_place_id: string | null;
  google_maps_url: string | null;
}

/** 门店在这个平台上的抓取入参 URL。null = 没配。 */
async function targetUrl(
  ctx: CommandContext,
  platform: ReviewPlatform,
): Promise<string | null> {
  const [row] = await withTenant(ctx, (tx) => tx<SourceRow[]>`
    select yelp_business_id, google_place_id, google_maps_url
    from locations where id = ${ctx.locationId}`);
  if (!row) return null;

  return platform === 'google'
    ? googleReviewsUrl({ mapsUrl: row.google_maps_url, placeId: row.google_place_id })
    : yelpReviewsUrl(row.yelp_business_id);
}

async function loadActiveRun(
  ctx: CommandContext,
  platform: ReviewPlatform,
): Promise<ActiveRun | null> {
  const [row] = await withTenant(ctx, (tx) => tx<{
    id: string; snapshot_id: string | null; requested_at: string;
  }[]>`
    select id, snapshot_id, requested_at::text as requested_at
    from review_sync_runs
    where location_id = ${ctx.locationId} and platform = ${platform}
      and status = 'running'
    order by requested_at desc limit 1`);

  return row
    ? { id: row.id, snapshotId: row.snapshot_id, requestedAt: row.requested_at }
    : null;
}

/** 距上一次采集（无论成败）过去了多少分钟。没有记录时返回 null。 */
async function minutesSinceLastRun(
  ctx: CommandContext,
  platform: ReviewPlatform,
): Promise<number | null> {
  const [row] = await withTenant(ctx, (tx) => tx<{ minutes: number | null }[]>`
    select extract(epoch from (now() - max(requested_at))) / 60 as minutes
    from review_sync_runs
    where location_id = ${ctx.locationId} and platform = ${platform}`);
  const value = row?.minutes;
  return value === null || value === undefined ? null : Number(value);
}

const systemDispatch = <T>(command: string, input: unknown, ctx: CommandContext) =>
  dispatch<T>(command, input, ctx, { systemOrigin: 'bright_data_review_sync' });

async function finish(
  ctx: CommandContext,
  runId: string,
  patch: {
    status: 'done' | 'failed';
    fetchedCount?: number; insertedCount?: number; skippedCount?: number;
    costMillicents?: number; error?: string | null;
  },
): Promise<void> {
  await systemDispatch('reviews.finishSyncRun', { runId, ...patch }, ctx);
}

/**
 * 推进一步。
 *
 * @param force 跳过节流（staging 手动入口用）。⚠️ 它跳过的只是「距上次多久」，
 *              跳不过唯一索引 —— 已经有进行中的采集时仍然只会去取结果，
 *              不会重复触发并重复计费。
 */
export async function advanceReviewSync(
  ctx: CommandContext,
  platform: ReviewPlatform,
  opts: { force?: boolean } = {},
): Promise<SyncOutcome> {
  const config = brightDataConfig(platform);
  if (!config) return empty(platform, 'disabled');

  const url = await targetUrl(ctx, platform);
  if (!url) return empty(platform, 'not_configured');

  const active = await loadActiveRun(ctx, platform);
  if (active) return pollRun(ctx, platform, active, config);

  if (!opts.force) {
    const since = await minutesSinceLastRun(ctx, platform);
    if (since !== null && since < reviewSyncSettings.staleMinutes()) {
      return empty(platform, 'throttled');
    }
  }
  return startRun(ctx, platform, url, config);
}

/**
 * 触发一次新的采集。
 *
 * ⭐ **先登记再触发**。反过来写的话，定时任务与手动入口在同一分钟内
 * 都判断「该同步了」时，两次触发都会成功、各自计费，而结果因为去重完全一致 ——
 * 从数据上看不出任何异常。先登记则第二次会在唯一索引上失败，
 * 一分钱都不会花出去。
 */
async function startRun(
  ctx: CommandContext,
  platform: ReviewPlatform,
  url: string,
  config: { apiKey: string; datasetId: string },
): Promise<SyncOutcome> {
  let runId: string;
  try {
    const started = await systemDispatch<{ runId: string }>('reviews.startSyncRun', {
      platform, source: 'bright_data', meta: { url, datasetId: config.datasetId },
    }, ctx);
    runId = started.result.runId;
  } catch (e) {
    /*
     * 走到这里通常是唯一索引冲突：另一条路径刚刚占住了位置，这不是错误。
     * 但**必须确认**确实有一次进行中的采集 —— 把所有登记失败一律当成
     * 「已经在跑了」的话，一个真正的写库故障会伪装成正常状态，
     * 表现为这家店永远处于「同步中」而实际上一次都没跑过。
     */
    const active = await loadActiveRun(ctx, platform);
    if (active) return { ...empty(platform, 'running'), runId: active.id };
    const error = e instanceof Error ? e.message : 'start_run_failed';
    return { ...empty(platform, 'failed'), error };
  }

  try {
    const snapshotId = await triggerSnapshot({
      url,
      daysLimit: reviewSyncSettings.daysLimit(),
      limit: reviewSyncSettings.maxReviews(),
    }, { apiKey: config.apiKey, datasetId: config.datasetId });

    await systemDispatch('reviews.attachSyncSnapshot', { runId, snapshotId }, ctx);
    return { ...empty(platform, 'started'), runId };
  } catch (e) {
    // 触发失败必须立刻收尾：留着 running 会占住唯一索引，
    // 让这家店在超时窗口内一次都同步不了
    const error = e instanceof Error ? e.message : 'trigger_failed';
    await finish(ctx, runId, { status: 'failed', error });
    return { ...empty(platform, 'failed'), runId, error };
  }
}

async function pollRun(
  ctx: CommandContext,
  platform: ReviewPlatform,
  run: ActiveRun,
  config: { apiKey: string; datasetId: string },
): Promise<SyncOutcome> {
  /*
   * ⚠️ 时间戳必须过 `parseTs`。Postgres 在这套连接下返回的是
   * `2026-08-31 12:33:39.1+00` —— 空格分隔且时区只有两位，`new Date()`
   * 认不出来，直接得到 Invalid Date。那样算出来的 age 是 NaN，
   * 超时判断会**永远不成立**，而唯一索引会把这家店的同步永久堵死。
   */
  const ageMinutes = (Date.now() - parseTs(run.requestedAt).getTime()) / 60_000;
  if (Number.isFinite(ageMinutes) && ageMinutes > reviewSyncSettings.timeoutMinutes()) {
    await finish(ctx, run.id, { status: 'failed', error: 'snapshot_timeout' });
    return { ...empty(platform, 'timed_out'), runId: run.id, error: 'snapshot_timeout' };
  }

  if (!run.snapshotId) {
    // 登记成功但触发那一步没能把 id 写回来（进程被杀）。这次采集已经
    // 无法认领，标失败让下一轮重新开始 —— 比永远堵着强
    await finish(ctx, run.id, { status: 'failed', error: 'snapshot_id_missing' });
    return { ...empty(platform, 'failed'), runId: run.id, error: 'snapshot_id_missing' };
  }

  const opts = { apiKey: config.apiKey, datasetId: config.datasetId };
  const progress = await snapshotProgress(run.snapshotId, opts);
  if (progress.status === 'running') {
    return { ...empty(platform, 'running'), runId: run.id };
  }
  if (progress.status === 'failed') {
    await finish(ctx, run.id, { status: 'failed', error: progress.error ?? 'snapshot_failed' });
    return { ...empty(platform, 'failed'), runId: run.id, error: progress.error ?? 'snapshot_failed' };
  }

  const records = await fetchSnapshot(run.snapshotId, opts);
  const { reviews, skipped } = mapReviews(records, platform);
  // 计费按返回条数计，与去掉多少条无关 —— 记的是真实花销，不是有效产出
  const costMillicents = records.length * reviewSyncSettings.costPerRecordMillicents();

  let inserted = 0;
  let updated = 0;
  if (reviews.length > 0) {
    const out = await systemDispatch<{ inserted: number; updated: number }>('reviews.ingest', {
      runId: run.id,
      platform,
      source: 'bright_data',
      reviews: reviews.map((r) => ({
        externalId: r.externalId,
        rating: r.rating,
        authorName: r.authorName,
        content: r.content,
        isExcerpt: r.isExcerpt,
        url: r.url,
        postedAt: r.postedAt,
      })),
    }, ctx);
    inserted = out.result.inserted;
    updated = out.result.updated;
  }

  /*
   * 抓取结果里的平台汇总只作为**兜底**写入。
   *
   * `location_review_stats` 的权威来源是 Yelp Fusion 与 Google Places 的详情
   * 接口（stats.ts）—— 它们免费、稳定，且不依赖抓取是否成功。这里写入是为了
   * 覆盖「详情接口不可用但抓取成功」的场合，冲突时按天覆盖，不会产生两行。
   */
  const stats = extractPlatformStats(records);
  if (stats.ratingBp !== null) {
    await systemDispatch('reviews.recordStats', {
      platform, ratingBp: stats.ratingBp, reviewCount: stats.reviewCount,
    }, ctx).catch(() => undefined);
  }

  await finish(ctx, run.id, {
    status: 'done',
    fetchedCount: records.length,
    insertedCount: inserted,
    skippedCount: skipped,
    costMillicents,
  });

  return {
    platform, state: 'ingested', runId: run.id,
    fetched: records.length, inserted, updated, skipped, costMillicents, error: null,
  };
}

/** 终态：不会再变了，调用方可以停止轮询 */
const TERMINAL: ReadonlySet<SyncState> = new Set<SyncState>([
  'not_configured', 'disabled', 'throttled', 'ingested', 'failed', 'timed_out',
]);

/**
 * 推进到终态或超时为止（staging 手动入口用）。
 *
 * 定时任务**不用**这个函数：它每轮推进一步就走，靠下一轮继续 ——
 * 后台任务里原地等待一次抓取完成，等于让一个进程为一家店占用数分钟。
 */
export async function syncReviewsNow(
  ctx: CommandContext,
  platform: ReviewPlatform,
  opts: { waitMs?: number; pollMs?: number } = {},
): Promise<SyncOutcome> {
  const deadline = Date.now() + (opts.waitMs ?? 0);
  const pollMs = opts.pollMs ?? 5_000;

  let outcome = await advanceReviewSync(ctx, platform, { force: true });
  while (!TERMINAL.has(outcome.state) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    outcome = await advanceReviewSync(ctx, platform, { force: true });
  }
  return outcome;
}
