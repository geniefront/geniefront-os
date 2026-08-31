/**
 * Bright Data Dataset API v3 客户端 —— 薄薄一层 fetch，业务逻辑在 map.ts。
 *
 * ## 为什么这条链路必须是异步三段式
 *
 * Bright Data 的抓取不是「请求—响应」：`trigger` 只登记一次采集任务并返回
 * `snapshot_id`，真正的抓取在其后台排队执行，耗时从数十秒到数分钟不等。
 * 因此调用方必须把 `snapshot_id` **持久化**（`review_sync_runs.snapshot_id`），
 * 由后续的定时轮询推进状态。
 *
 * 把它写成「触发后原地等待完成」会同时踩两个坑：
 *   1. HTTP 请求或进程在等待期间结束，已经产生费用的快照被永久遗弃；
 *   2. 重试逻辑退化为「再触发一次」，同一份数据被抓取并计费多次。
 *
 * ## 费用
 *
 * 计费按返回记录条数计，与耗时无关。因此 `fetchSnapshot` 返回的条数就是
 * 计费口径，调用方据此写入 `review_sync_runs.cost_millicents`。
 */

import { AppError, ERROR_CODES } from '@gf/contracts';

const BASE = 'https://api.brightdata.com/datasets/v3';

export interface BrightDataOptions {
  apiKey: string;
  /**
   * 数据集 id。不同数据集的字段与计价不同，且会随平台改版更新，
   * 因此由环境变量提供而不写死在代码里（见 .env.example 的 D 段）。
   */
  datasetId: string;
  timeoutMs?: number;
  /** 注入用，测试里替换掉真实网络 */
  fetchImpl?: typeof fetch;
}

/**
 * 快照状态。
 *
 * `running` 涵盖 Bright Data 的 `running` / `collecting` / `building` 三种中间态 ——
 * 对调用方而言它们的处置完全一致（继续等），区分只会让状态机多出两条等价分支。
 */
export type SnapshotStatus = 'running' | 'ready' | 'failed';

async function call<T>(
  path: string,
  init: RequestInit,
  opts: BrightDataOptions,
): Promise<T> {
  const f = opts.fetchImpl ?? fetch;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 30_000);

  try {
    const res = await f(`${BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        Accept: 'application/json',
        ...(init.headers ?? {}),
      },
      signal: ac.signal,
    });

    if (res.status === 429) {
      // 配额或并发上限。这是「稍后再来」而不是「配置错了」，
      // 两者在 review_sync_runs 里必须分得开，否则重试策略无从制定
      throw new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE, {
        details: { service: 'bright_data', reason: 'rate_limited' },
      });
    }
    if (!res.ok) {
      throw new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE, {
        details: { service: 'bright_data', status: res.status },
      });
    }
    return await res.json() as T;
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE, {
      details: { service: 'bright_data', reason: e instanceof Error ? e.message : 'unknown' },
      cause: e,
    });
  } finally {
    clearTimeout(timer);
  }
}

export interface TriggerInput {
  /** 门店页 URL（Google Maps 或 Yelp biz 页），由 map.ts 的两个构造函数生成 */
  url: string;
  /** 只抓最近 N 天。增量同步的主要降本手段 */
  daysLimit?: number;
  /** 单店抓取上限，对应 05 §8.1 的 Top 50 */
  limit?: number;
}

/**
 * 登记一次采集任务，返回 `snapshot_id`。
 *
 * ⚠️ 调用方必须在**任何后续操作之前**把返回的 id 落库。
 * 费用在这一刻已经确定要发生，丢掉 id 等于花了钱却拿不到数据，
 * 而且下一轮定时任务会因为「没有进行中的任务」再触发一次，重复计费。
 */
export async function triggerSnapshot(
  input: TriggerInput,
  opts: BrightDataOptions,
): Promise<string> {
  const query = new URLSearchParams({
    dataset_id: opts.datasetId,
    // 抓取过程中的单条错误照常返回，便于在同步日志里看到「抓了但有几条失败」，
    // 而不是整批静默变短
    include_errors: 'true',
  });
  const payload: Record<string, unknown> = { url: input.url };
  if (input.daysLimit !== undefined) payload['days_limit'] = input.daysLimit;
  if (input.limit !== undefined) payload['num_of_reviews'] = input.limit;

  const body = await call<{ snapshot_id?: string }>(`/trigger?${query.toString()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([payload]),
  }, opts);

  const snapshotId = body.snapshot_id?.trim();
  if (!snapshotId) {
    throw new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE, {
      details: { service: 'bright_data', reason: 'missing_snapshot_id' },
    });
  }
  return snapshotId;
}

export interface SnapshotProgress {
  status: SnapshotStatus;
  /** 已产出的记录数。ready 之前只是进度提示，不作为计费依据 */
  records: number | null;
  /** 失败原因，原样写进 review_sync_runs.error 供排查 */
  error: string | null;
}

export async function snapshotProgress(
  snapshotId: string,
  opts: BrightDataOptions,
): Promise<SnapshotProgress> {
  const body = await call<{
    status?: string; records?: number; error?: string; error_message?: string;
  }>(`/progress/${encodeURIComponent(snapshotId)}`, { method: 'GET' }, opts);

  const raw = (body.status ?? '').toLowerCase();
  const status: SnapshotStatus = raw === 'ready'
    ? 'ready'
    : (raw === 'failed' || raw === 'canceled' || raw === 'cancelled' ? 'failed' : 'running');

  return {
    status,
    records: typeof body.records === 'number' ? body.records : null,
    error: body.error ?? body.error_message ?? null,
  };
}

/**
 * 下载已就绪的快照。
 *
 * Bright Data 在 `ready` 之前对该端点返回 202 且**不带记录**。这里把
 * 「非数组」一律当成空结果而不是抛错：状态查询与下载之间存在竞态，
 * 抛错会让一次正常的时序抖动变成同步失败并触发重试，重试再次计费。
 */
export async function fetchSnapshot(
  snapshotId: string,
  opts: BrightDataOptions,
): Promise<Record<string, unknown>[]> {
  const body = await call<unknown>(
    `/snapshot/${encodeURIComponent(snapshotId)}?format=json`, { method: 'GET' }, opts);

  if (Array.isArray(body)) {
    return body.filter((row): row is Record<string, unknown> =>
      typeof row === 'object' && row !== null);
  }
  // 某些数据集把结果包在 { data: [...] } 里
  if (body && typeof body === 'object' && Array.isArray((body as { data?: unknown }).data)) {
    return ((body as { data: unknown[] }).data).filter(
      (row): row is Record<string, unknown> => typeof row === 'object' && row !== null);
  }
  return [];
}
