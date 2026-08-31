export interface TrendPoint {
  date: string;
  serviceRevenueCents: number;
  retailRevenueCents: number;
  giftCardSalesCents: number;
  tipCents: number;
  discountCents: number;
  netCents: number;
}

export interface CategorySlice {
  categoryId: string;
  name: string;
  revenueCents: number;
  percentBp: number;
}

export interface PaymentMethodBreakdown {
  cashCents: number;
  cardCents: number;
  giftCardCents: number;
  externalCents: number;
}

export interface RevenueTrendsResponse {
  trends: TrendPoint[];
  byCategory: CategorySlice[];
  byPaymentMethod: PaymentMethodBreakdown;
}

export interface CustomerRetentionResponse {
  totalVisits: number;
  newCustomerVisits: number;
  returningCustomerVisits: number;
  retentionRateBp: number;
  averageTicketCents: number;
  sleepingCustomerCount: number;
}

export interface StaffAnalyticsRow {
  membershipId: string;
  name: string;
  serviceCount: number;
  salesCents: number;
  tipsCents: number;
  commissionCents: number;
  requestRateBp: number;
}

export interface StaffAnalyticsResponse {
  rows: StaffAnalyticsRow[];
}

export interface HeatmapResponse {
  matrix: Record<string, number[]>;
  peakHour: string;
  avgCapacityUtilizationBp: number;
}

export interface RfmAnalyticsResponse {
  cohorts: {
    vip: { count: number; revenueCents: number; avgTicketCents: number; visitFrequency: number };
    active: { count: number; revenueCents: number; avgTicketCents: number; visitFrequency: number };
    new: { count: number; avgFirstTicketCents: number; secondVisitRateBp: number };
    sleeping: { count: number; atRiskRevenueCents: number; inactiveDaysThreshold: number };
  };
  channels: Array<{
    channelName: string;
    customerCount: number;
    percentBp: number;
  }>;
}

export interface TopServiceItem {
  rank: number;
  serviceId: string;
  name: string;
  categoryName: string;
  salesCount: number;
  revenueCents: number;
  costCents: number;
  marginPercent: number;
  avgDurationMinutes: number;
  rating: number;
}

export interface TopServicesResponse {
  services: TopServiceItem[];
}

export interface CopilotSummaryResponse {
  highlights: string[];
  risks: string[];
  actions: string[];
  generatedAt: string;
}

export interface ReviewPlatformStats {
  score: number;
  count: number;
}

export interface ReviewSummaryResponse {
  overallScore: number;
  totalReviewCount: number;
  satisfactionRate: number;
  platformBreakdown: {
    google: ReviewPlatformStats;
    yelp: ReviewPlatformStats;
    inStore: ReviewPlatformStats;
  };
  aiSummary: {
    overview: string;
    /** 结论可信度（05 §8.3）。`low` 时页面必须标出「样本不完整，仅供参考」 */
    confidence: 'low' | 'medium' | 'high' | null;
    /** 摘要里有多少比例来自被平台截断的正文 */
    excerptRatioBp: number;
    /** 摘要生成时间。为空 = 还没跑过 */
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
