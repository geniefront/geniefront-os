/** 评价与多平台口碑聚合分析。 */

import type postgres from 'postgres';
import type { CommandContext } from '@gf/contracts';

export interface ReviewPlatformStatsDto {
  score: number;
  count: number;
}

export interface ReviewSummaryDto {
  overallScore: number;
  totalReviewCount: number;
  satisfactionRate: number;
  platformBreakdown: {
    google: ReviewPlatformStatsDto;
    yelp: ReviewPlatformStatsDto;
    inStore: ReviewPlatformStatsDto;
  };
  aiSummary: {
    overview: string;
    /**
     * 结论的可信度（05 §8.3）。摘录占比过高或样本太少时是 `low`，
     * 老板端必须在结论旁标出「样本不完整，仅供参考」—— 否则一个由三条
     * 截断评价归纳出来的建议，看起来和三十条完整评价归纳出来的一模一样。
     */
    confidence: 'low' | 'medium' | 'high' | null;
    /** 摘要里有多少比例来自被平台截断的正文 */
    excerptRatioBp: number;
    /** 这份摘要是什么时候生成的。为空 = 还没跑过 */
    generatedAt: string | null;
    topKeywords: Array<{ tag: string; count: number; sentiment: 'positive' | 'warning' | 'neutral' }>;
    actionableSuggestions: Array<{ type: 'warning' | 'tip'; title: string; description: string }>;
    topStaff: Array<{
      membershipId: string;
      name: string;
      tier: string;
      reviewCount: number;
      rating: number;
      specialty: string;
    }>;
  };
  recentReviews: Array<{
    id: string;
    customerName: string;
    rating: number;
    platform: string;
    timeAgo: string;
    technicianName: string | null;
    serviceName: string | null;
    content: string | null;
    sentimentTag: string;
    highlights: string[];
  }>;
}

type ReviewRow = {
  id: string;
  platform: string;
  rating: number | null;
  author_name: string | null;
  content: string | null;
  posted_at: string | null;
  scraped_at: string;
  ai_sentiment: string | null;
  ai_highlights: unknown;
  technician_name: string | null;
  service_name: string | null;
};

function platformStats(reviews: ReviewRow[], platform: 'google' | 'yelp' | 'inStore'): ReviewPlatformStatsDto {
  const rows = reviews.filter((review) => {
    if (platform === 'inStore') return review.platform !== 'google' && review.platform !== 'yelp';
    return review.platform === platform;
  });
  const rated = rows.filter((review): review is ReviewRow & { rating: number } => review.rating != null);
  return {
    score: rated.length > 0
      ? Number((rated.reduce((sum, review) => sum + review.rating, 0) / rated.length).toFixed(2))
      : 0,
    count: rows.length,
  };
}

export async function loadReviewsSummary(
  tx: postgres.TransactionSql,
  ctx: CommandContext,
): Promise<ReviewSummaryDto> {
  const reviews = await tx<ReviewRow[]>`
    select id, platform, rating, author_name, content,
           posted_at::text as posted_at, scraped_at::text as scraped_at,
           ai_sentiment, ai_highlights, technician_name, service_name
    from location_reviews
    where location_id = ${ctx.locationId}
    order by coalesce(posted_at, scraped_at) desc
    limit 100`;

  const rated = reviews.filter((review): review is ReviewRow & { rating: number } => review.rating != null);
  const overallScore = rated.length > 0
    ? Number((rated.reduce((sum, review) => sum + review.rating, 0) / rated.length).toFixed(2))
    : 0;
  const positiveCount = rated.filter((review) => review.rating >= 4).length;
  const satisfactionRate = rated.length > 0
    ? Number(((positiveCount / rated.length) * 100).toFixed(1))
    : 0;
  const now = Date.now();
  const [summary] = await tx<{
    content: unknown; excerpt_ratio_bp: number; generated_at: string;
  }[]>`
    select summary_content as content, excerpt_ratio_bp,
           generated_at::text as generated_at
    from review_summaries
    where location_id = ${ctx.locationId} order by generated_at desc limit 1`;
  const summaryContent = summary?.content && typeof summary.content === 'object'
    ? summary.content as Record<string, unknown> : {};
  const overview = typeof summaryContent['overview'] === 'string' ? summaryContent['overview'] : '';
  const topKeywords = Array.isArray(summaryContent['topKeywords'])
    ? summaryContent['topKeywords'].filter((value): value is ReviewSummaryDto['aiSummary']['topKeywords'][number] => {
      if (!value || typeof value !== 'object') return false;
      const row = value as Record<string, unknown>;
      return typeof row['tag'] === 'string' && typeof row['count'] === 'number'
        && ['positive','warning','neutral'].includes(String(row['sentiment']));
    }) : [];
  const suggestions = Array.isArray(summaryContent['actionableSuggestions'])
    ? summaryContent['actionableSuggestions'].filter((value): value is ReviewSummaryDto['aiSummary']['actionableSuggestions'][number] => {
      if (!value || typeof value !== 'object') return false;
      const row = value as Record<string, unknown>;
      return ['warning','tip'].includes(String(row['type']))
        && typeof row['title'] === 'string' && typeof row['description'] === 'string';
    }) : [];

  return {
    overallScore,
    totalReviewCount: reviews.length,
    satisfactionRate,
    platformBreakdown: {
      google: platformStats(reviews, 'google'),
      yelp: platformStats(reviews, 'yelp'),
      inStore: platformStats(reviews, 'inStore'),
    },
    aiSummary: {
      overview,
      // 认不出的取值一律当成「没有」而不是猜一个 medium：
      // 可信度标签本身就是用来降低轻信的，默认值不能反过来抬高它
      confidence: ['low', 'medium', 'high'].includes(String(summaryContent['confidence']))
        ? summaryContent['confidence'] as 'low' | 'medium' | 'high'
        : null,
      excerptRatioBp: summary?.excerpt_ratio_bp ?? 0,
      generatedAt: summary?.generated_at ?? null,
      topKeywords,
      actionableSuggestions: suggestions,
      topStaff: [],
    },
    recentReviews: reviews.slice(0, 10).map((review) => {
      const timestamp = new Date(review.posted_at ?? review.scraped_at).getTime();
      const hoursAgo = Math.max(0, Math.round((now - timestamp) / 3_600_000));
      const highlights = Array.isArray(review.ai_highlights)
        ? review.ai_highlights.filter((item): item is string => typeof item === 'string')
        : [];
      return {
        id: review.id,
        customerName: review.author_name ?? '匿名顾客',
        rating: review.rating ?? 0,
        platform: review.platform,
        timeAgo: hoursAgo >= 24 ? `${Math.round(hoursAgo / 24)} 天前` : `${hoursAgo} 小时前`,
        technicianName: review.technician_name,
        serviceName: review.service_name,
        content: review.content,
        sentimentTag: review.ai_sentiment ?? '',
        highlights,
      };
    }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 采集配置与同步日志（05 §8）
// ─────────────────────────────────────────────────────────────────────────────

export interface ReviewSourcesDto {
  googlePlaceId: string | null;
  googleMapsUrl: string | null;
  yelpBusinessId: string | null;
  /** 缺哪一项就抓不到哪个平台 —— 设置页要能直接告诉老板还差什么 */
  googleReady: boolean;
  yelpReady: boolean;
}

export async function loadReviewSources(
  tx: postgres.TransactionSql,
  ctx: CommandContext,
): Promise<ReviewSourcesDto> {
  const [row] = await tx<{
    google_place_id: string | null; google_maps_url: string | null; yelp_business_id: string | null;
  }[]>`
    select google_place_id, google_maps_url, yelp_business_id
    from locations where id = ${ctx.locationId}`;

  return {
    googlePlaceId: row?.google_place_id ?? null,
    googleMapsUrl: row?.google_maps_url ?? null,
    yelpBusinessId: row?.yelp_business_id ?? null,
    googleReady: Boolean(row?.google_maps_url || row?.google_place_id),
    yelpReady: Boolean(row?.yelp_business_id),
  };
}

export interface ReviewSyncRunDto {
  id: string;
  platform: string;
  source: string;
  status: string;
  requestedAt: string;
  finishedAt: string | null;
  attempts: number;
  fetched: number;
  inserted: number;
  skipped: number;
  /** 抓取花费，单位毫分（1/1000 分）。前端要显示成分时自己除，不在这里丢精度 */
  costMillicents: number;
  error: string | null;
}

/**
 * 最近的同步记录。
 *
 * ⚠️ 不返回 `snapshot_id`：它是 Bright Data 侧的凭据性标识，
 * 拿到它的人可以直接向 Bright Data 拉走这次抓取的全部结果。
 * 排障要用它时去查库，不从 HTTP 接口吐出来。
 */
export async function loadReviewSyncRuns(
  tx: postgres.TransactionSql,
  ctx: CommandContext,
  limit: number,
): Promise<ReviewSyncRunDto[]> {
  const rows = await tx<{
    id: string; platform: string; source: string; status: string;
    requested_at: string; finished_at: string | null; attempts: number;
    fetched_count: number; inserted_count: number; skipped_count: number;
    cost_millicents: number; error: string | null;
  }[]>`
    select id, platform, source, status,
           requested_at::text as requested_at, finished_at::text as finished_at,
           attempts, fetched_count, inserted_count, skipped_count,
           cost_millicents, error
    from review_sync_runs
    where location_id = ${ctx.locationId}
    order by requested_at desc
    limit ${limit}`;

  return rows.map((row) => ({
    id: row.id,
    platform: row.platform,
    source: row.source,
    status: row.status,
    requestedAt: row.requested_at,
    finishedAt: row.finished_at,
    attempts: row.attempts,
    fetched: row.fetched_count,
    inserted: row.inserted_count,
    skipped: row.skipped_count,
    costMillicents: row.cost_millicents,
    error: row.error,
  }));
}
