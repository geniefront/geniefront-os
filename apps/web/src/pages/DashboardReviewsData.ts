export interface CustomerReviewItem {
  id: string;
  customerName: string;
  avatarText: string;
  rating: number;
  platform: 'google' | 'yelp' | 'in_store' | 'redbook';
  platformLabel: string;
  timeAgo: string;
  technicianName?: string;
  serviceName: string;
  content: string;
  sentiment: 'positive' | 'neutral' | 'suggestion';
  sentimentTag: string;
  highlights: string[];
}
