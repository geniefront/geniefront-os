/**
 * 外部评价采集的前端数据形状（05-AI-INTEGRATION §8）。
 *
 * 与 `apps/api/src/queries/reviews.ts` 的 DTO 一一对应。
 */

export interface ReviewSources {
  googlePlaceId: string | null;
  googleMapsUrl: string | null;
  yelpBusinessId: string | null;
  /** 缺哪一项就抓不到哪个平台 —— 设置页据此直接告诉老板还差什么 */
  googleReady: boolean;
  yelpReady: boolean;
  /**
   * 平台侧是否放开了「手动同步」。false 时同步按钮禁用并提示「暂未开放」，
   * 不发一个必然 403 的请求，也不让老板误以为是配置/权限问题（§8.2）。
   */
  manualSyncEnabled: boolean;
}

export interface ConfigureReviewSourcesInput {
  /**
   * ⚠️ 不传 = 不动这一项，传 null = 清空。两者必须分开：
   * 老板只改 Yelp id 时不该把 Google 的配置连带清掉，
   * 而想彻底停掉某个平台的抓取时又必须有办法真的清空。
   */
  googlePlaceId?: string | null;
  googleMapsUrl?: string | null;
  yelpBusinessId?: string | null;
}

export type ReviewSyncStatus = 'running' | 'done' | 'failed';

export interface ReviewSyncRun {
  id: string;
  platform: string;
  source: string;
  status: ReviewSyncStatus;
  requestedAt: string;
  finishedAt: string | null;
  attempts: number;
  fetched: number;
  /** 去重之后真正新写入的条数。长期为 0 说明增量正常，不是故障 */
  inserted: number;
  skipped: number;
  /** 抓取花费，单位毫分（1/1000 分） */
  costMillicents: number;
  error: string | null;
}

/** 一次推进的结果。每一种都要能分开显示 —— 它们在老板端长得都像「没有新评价」 */
export type SyncState =
  | 'not_configured' | 'disabled' | 'throttled' | 'started'
  | 'running' | 'ingested' | 'timed_out' | 'failed';

export interface SyncOutcome {
  platform: 'google' | 'yelp';
  state: SyncState;
  runId: string | null;
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
  costMillicents: number;
  error: string | null;
}

export interface StatsRefreshOutcome {
  platform: 'google' | 'yelp';
  state: 'recorded' | 'skipped' | 'failed';
  ratingBp: number | null;
  reviewCount: number | null;
  excerptsIngested: number;
  error: string | null;
}

export interface ManualSyncResponse {
  stats: StatsRefreshOutcome[];
  sync: SyncOutcome[];
  analysis: { analyzed: number; updated: number; state: string } | null;
  summary: {
    state: string; summaryId: string | null;
    reviewCount: number; excerptRatioBp: number;
  } | null;
}
