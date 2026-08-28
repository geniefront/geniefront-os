/**
 * 外部评价（02-DATA-MODEL §18）
 *
 * 两个平台、两条采集路径，性质完全不同，所以必须能分辨：
 *
 *   Google  ← Bright Data 抓取，完整评价正文
 *   Yelp    ← ① Fusion 官方 API：权威的 rating / review_count，
 *                 但 reviews 端点**只给 3 条、正文截断到约 160 字**
 *             ② Bright Data：完整正文（Phase 3 再上）
 *
 * `is_excerpt` 这个字段看着不起眼，但没有它 AI 摘要会出错 ——
 * 把截断的半句话当成完整评价喂给模型，它会对着被切掉的句子下结论。
 */

import {
  pgTable, uuid, text, jsonb, boolean, integer, timestamp, date, index, uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations, locations } from './tenancy';
import { customers, services } from './scheduling';
import { memberships } from './identity';
import { tickets } from './tickets';

const id = () => uuid('id').primaryKey().defaultRandom();
const orgCol = () => uuid('org_id').notNull().references(() => organizations.id);
const locCol = () => uuid('location_id').notNull().references(() => locations.id);

export const locationReviews = pgTable('location_reviews', {
  id: id(),
  orgId: orgCol(),
  locationId: locCol(),
  platform: text('platform').notNull(),          // google | yelp
  /** 怎么拿到的。决定了正文完不完整、能不能信 */
  source: text('source').notNull(),              // yelp_fusion | bright_data
  externalId: text('external_id').notNull(),
  rating: integer('rating'),                     // 1–5
  authorName: text('author_name'),
  content: text('content'),
  /** ⚠️ true = 正文被平台截断了。AI 摘要必须知道，否则会对半句话下结论 */
  isExcerpt: boolean('is_excerpt').notNull().default(false),
  url: text('url'),
  postedAt: timestamp('posted_at', { withTimezone: true }),
  scrapedAt: timestamp('scraped_at', { withTimezone: true }).notNull().defaultNow(),
  status: text('status').notNull().default('new'), // new | replied | ignored
  aiSentiment: text('ai_sentiment'),
  aiHighlights: jsonb('ai_highlights').notNull().default(sql`'[]'::jsonb`),
  technicianName: text('technician_name'),
  serviceName: text('service_name'),
  serviceId: uuid('service_id').references(() => services.id),
  membershipId: uuid('membership_id').references(() => memberships.id),
  customerId: uuid('customer_id').references(() => customers.id),
  ticketId: uuid('ticket_id').references(() => tickets.id),
}, (t) => [
  // 同一条评价重复抓到不该产生两行
  uniqueIndex('location_reviews_dedup').on(t.locationId, t.platform, t.externalId),
  index('location_reviews_recent').on(t.locationId, t.platform, t.postedAt),
  index('location_reviews_service_idx').on(t.locationId, t.serviceId, t.postedAt),
  index('location_reviews_membership_idx').on(t.locationId, t.membershipId, t.postedAt),
]);

/**
 * 平台侧的权威汇总。
 *
 * 单独存是因为它和评价正文的采集节奏不同：Fusion API 每天一次就能拿到
 * 准确的 rating 与 review_count（免费、稳定），而完整正文要靠抓取。
 * 老板端看的「口碑趋势」用这张表，不依赖抓取是否成功。
 */
export const locationReviewStats = pgTable('location_review_stats', {
  id: id(),
  orgId: orgCol(),
  locationId: locCol(),
  platform: text('platform').notNull(),
  onDate: date('on_date').notNull(),
  /** 平台显示的平均分。存 basis point 避免浮点：4.4 → 44000 */
  ratingBp: integer('rating_bp'),
  reviewCount: integer('review_count'),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('location_review_stats_daily').on(t.locationId, t.platform, t.onDate),
]);

export const reviewSummaries = pgTable('review_summaries', {
  id: id(),
  orgId: orgCol(),
  locationId: locCol(),
  periodStart: date('period_start').notNull(),
  periodEnd: date('period_end').notNull(),
  /** 这次摘要覆盖了哪些平台，以及各自的条数 —— 老板要知道结论的来源 */
  coverage: jsonb('coverage').notNull(),
  /** 用于增量判断：最新一条评价的 external_id 没变就不调模型 */
  latestReviewId: text('latest_review_id'),
  summaryContent: jsonb('summary_content').notNull(),
  /** 摘要里有多少比例来自截断正文 —— 太高的话结论要打折看 */
  excerptRatioBp: integer('excerpt_ratio_bp').notNull().default(0),
  generatedAt: timestamp('generated_at', { withTimezone: true }).notNull().defaultNow(),
  tokenCostCents: integer('token_cost_cents').notNull().default(0),
}, (t) => [
  index('review_summaries_recent').on(t.locationId, t.generatedAt),
]);
