/**
 * 评价采集的环境配置（05-AI-INTEGRATION §8）
 *
 * 集中在一个文件里，是因为这条链路**花钱**：抓取按记录条数计费，模型按 token
 * 计费。散落在各处的 `process.env[...] ?? 某个默认值` 会让「这家店一个月
 * 到底会产生多少费用」变成一个没人能一次答出来的问题。
 *
 * ⚠️ 默认**关闭**（`REVIEW_SYNC_INTERVAL_MINUTES` 不设或为 0）。
 * 按 05 §8 的上线顺序：先用 staging 手动入口验证一遍，再打开定时任务。
 */

/** 数据集 id 随平台改版更新，因此可由环境变量覆盖 */
const DEFAULT_GOOGLE_DATASET = 'gd_luzfs1dn2oa0teb81mz';
const DEFAULT_YELP_DATASET = 'gd_lgugwl0519h1p14rwk';

export interface BrightDataConfig {
  apiKey: string;
  datasetId: string;
}

/**
 * 取某个平台的 Bright Data 配置。返回 null = 没配，调用方跳过该平台。
 *
 * 「没配」和「配错了」必须分开：前者是正常状态（还没开这个平台），
 * 后者应当在同步日志里留下失败记录。因此这里只判断有没有，不做连通性猜测。
 */
export function brightDataConfig(platform: 'google' | 'yelp'): BrightDataConfig | null {
  const apiKey = process.env['BRIGHT_DATA_API_KEY']?.trim();
  if (!apiKey) return null;

  const datasetId = (platform === 'google'
    ? process.env['BRIGHT_DATA_GOOGLE_REVIEWS_DATASET']?.trim() || DEFAULT_GOOGLE_DATASET
    : process.env['BRIGHT_DATA_YELP_REVIEWS_DATASET']?.trim() || DEFAULT_YELP_DATASET);

  return { apiKey, datasetId };
}

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(raw)));
}

export const reviewSyncSettings = {
  /** 只抓最近 N 天。增量同步的主要降本手段 */
  daysLimit: () => intEnv('REVIEW_SYNC_DAYS_LIMIT', 60, 1, 365),
  /** 单店单次抓取上限（05 §8.1 的 Top 50） */
  maxReviews: () => intEnv('REVIEW_SYNC_MAX_REVIEWS', 50, 1, 200),
  /** 距上一次采集多久算「该同步了」。默认 12 小时 = 每天两次机会 */
  staleMinutes: () => intEnv('REVIEW_SYNC_STALE_MINUTES', 720, 30, 20_160),
  /**
   * 一次采集卡在 running 多久算作失败。
   *
   * ⚠️ 这个上限不是可选项：唯一索引保证一家店一个平台只能有一次进行中的采集，
   * 没有超时的话，一次永远不会 ready 的快照会把这家店的评价同步**永久堵死**，
   * 而表现只是「评价从某天起不再更新」。
   */
  timeoutMinutes: () => intEnv('REVIEW_SYNC_TIMEOUT_MINUTES', 120, 10, 1_440),
  /** 一轮定时任务最多处理几家店 */
  batchSize: () => intEnv('REVIEW_SYNC_BATCH', 20, 1, 200),
  /**
   * 每条记录的抓取成本，单位毫分（1/1000 分）。默认 0.15 分/条。
   * 只用于在同步日志里估算费用，不参与任何扣费。
   */
  costPerRecordMillicents: () => intEnv('BRIGHT_DATA_COST_PER_RECORD_MILLICENTS', 150, 0, 100_000),
};

/**
 * staging 手动同步入口是否开放。
 *
 * 生产默认关闭：这个入口会**立即产生抓取费用**，而它的用途是上线前验证。
 * 需要在生产临时手动触发时显式打开，用完关掉。
 */
export function manualSyncEnabled(): boolean {
  const flag = process.env['REVIEW_SYNC_MANUAL_ENABLED'];
  if (flag !== undefined) return flag === '1' || flag.toLowerCase() === 'true';
  return process.env['NODE_ENV'] !== 'production';
}
