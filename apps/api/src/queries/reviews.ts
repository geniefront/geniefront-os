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
      overview: '',
      topKeywords: [],
      actionableSuggestions: [],
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
