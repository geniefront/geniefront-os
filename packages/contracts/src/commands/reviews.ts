/**
 * 外部评价采集与 AI 口碑分析的写命令（05-AI-INTEGRATION §8）
 *
 * ## 为什么这里有五条系统自有命令
 *
 * 采集链路的每一步都要写库：登记一次抓取、写入评价正文、刷新平台评分、
 * 收尾同步记录、保存模型产出。它们**必须**是命令而不是任务代码里的裸 SQL ——
 * 否则审计、租户事务、欠费冻结会随着「这是后台任务」的理由被逐条绕过，
 * 而这正是宪法第 1 条要防的事（lint-guards 第 9 条也会拦下来）。
 *
 * 同时它们都标了 `system: true`：租户没有任何理由自己声明
 * 「我抓到了 50 条五星好评」。这条路只能由服务端编排在拿到外部回执之后走
 * （AUD-01 第二道，见 bus.ts 的 `systemOrigin`）。
 */

import { z } from 'zod';
import { defineCommand, uuid } from '../command.js';

const platform = z.enum(['google', 'yelp']);
const source = z.enum(['bright_data', 'yelp_fusion', 'google_places']);

/**
 * 门店的采集配置。
 *
 * 每一项都是 `nullable().optional()`：不传 = 不动，传 null = 清空。
 * 两者必须能分开 —— 老板在设置页只改 Yelp id 时，不该把 Google 的配置
 * 连带清掉；而想彻底停掉某个平台的抓取时，又必须有办法真的清空。
 */
export const ConfigureReviewSources = defineCommand({
  name: 'location.configureReviewSources',
  input: z.object({
    googlePlaceId: z.string().min(1).max(255).nullable().optional(),
    /** Bright Data Google 数据集的入参门店页 URL。为空时由 place_id 拼出 */
    googleMapsUrl: z.string().url().max(2000).nullable().optional(),
    yelpBusinessId: z.string().min(1).max(120).nullable().optional(),
  }),
  output: z.object({ locationId: uuid, configured: z.array(z.string()) }),
  permission: 'settings.manage',
  ai: {
    description: '设置本店在 Google / Yelp 上的门店标识，用于每日抓取外部评价。',
    confirm: 'always',
  },
  reversible: true,
  idempotency: 'optional',
});

/**
 * 登记一次采集 —— **在调用 Bright Data 之前**。
 *
 * 表上有一条 (location, platform) where status='running' 的唯一索引，
 * 因此这一步同时起到「占位」的作用：并发的第二次同步会在这里失败，
 * 而不是在花掉抓取费用之后才发现重复。触发成功后用
 * `reviews.attachSyncSnapshot` 把 id 补进来。
 */
export const StartReviewSyncRun = defineCommand({
  name: 'reviews.startSyncRun',
  system: true,
  input: z.object({
    platform,
    source,
    snapshotId: z.string().min(1).max(200).nullable().optional(),
    meta: z.record(z.unknown()).optional(),
  }),
  output: z.object({ runId: uuid }),
  permission: 'report.view',
  ai: { description: '（内部）登记一次外部评价采集。', confirm: 'never', exposed: false },
  reversible: false,
  idempotency: 'optional',
});

/**
 * 把 Bright Data 返回的 `snapshotId` 补进已登记的运行记录。
 *
 * 顺序是有讲究的：**先登记（占住唯一索引）再触发**。反过来的话，定时任务与
 * staging 手动入口在同一分钟内都判断「该同步了」时，两次触发都会成功并各自计费，
 * 而结果因为去重完全一致 —— 从数据上看不出任何异常。
 */
export const AttachSyncSnapshot = defineCommand({
  name: 'reviews.attachSyncSnapshot',
  system: true,
  input: z.object({ runId: uuid, snapshotId: z.string().min(1).max(200) }),
  output: z.object({ runId: uuid }),
  permission: 'report.view',
  ai: { description: '（内部）记录抓取快照标识。', confirm: 'never', exposed: false },
  reversible: false,
  idempotency: 'optional',
});

/**
 * 收尾一次采集。
 *
 * `status: 'failed'` 同样要写完整的计数与错误原因：采集失败在老板端表现为
 * 「最近没有新评价」，与真的没人写评价无法区分，这一行是唯一能分开两者的东西。
 */
export const FinishReviewSyncRun = defineCommand({
  name: 'reviews.finishSyncRun',
  system: true,
  input: z.object({
    runId: uuid,
    status: z.enum(['done', 'failed']),
    fetchedCount: z.number().int().min(0).default(0),
    insertedCount: z.number().int().min(0).default(0),
    skippedCount: z.number().int().min(0).default(0),
    /** ⚠️ 单位是**毫分**（1/1000 分），与 @gf/ai 的成本口径一致 */
    costMillicents: z.number().int().min(0).default(0),
    error: z.string().max(2000).nullable().optional(),
  }),
  output: z.object({ runId: uuid, status: z.string() }),
  permission: 'report.view',
  ai: { description: '（内部）收尾一次外部评价采集。', confirm: 'never', exposed: false },
  reversible: false,
  idempotency: 'optional',
});

/**
 * 写入抓到的评价。
 *
 * 去重键是 (location_id, platform, external_id)，冲突时**只补正文与评分**，
 * 不覆盖 AI 分析结果与人工处理状态 —— 一条已经回复过的差评，不该因为
 * 第二天又被抓到一次就退回「未处理」。
 */
export const IngestReviews = defineCommand({
  name: 'reviews.ingest',
  system: true,
  input: z.object({
    runId: uuid.nullable().optional(),
    platform,
    source,
    reviews: z.array(z.object({
      externalId: z.string().min(1).max(300),
      rating: z.number().int().min(1).max(5).nullable(),
      authorName: z.string().max(200).nullable(),
      content: z.string().max(20_000).nullable(),
      /** ⚠️ true = 正文被平台截断。摘要提示词据此警告模型（05 §8.3） */
      isExcerpt: z.boolean().default(false),
      url: z.string().max(2000).nullable(),
      postedAt: z.string().max(40).nullable(),
    })).max(200),
  }),
  output: z.object({
    inserted: z.number().int().min(0),
    updated: z.number().int().min(0),
  }),
  permission: 'report.view',
  ai: { description: '（内部）写入抓取到的外部评价。', confirm: 'never', exposed: false },
  reversible: false,
  idempotency: 'optional',
});

/**
 * 平台侧权威评分（05 §8.1）。
 *
 * 按天一行。老板端的口碑趋势只依赖这张表 —— 它来自免费稳定的官方接口，
 * 抓取挂了也不影响看分数。
 */
export const RecordReviewStats = defineCommand({
  name: 'reviews.recordStats',
  system: true,
  input: z.object({
    platform,
    /** basis point：4.4 → 44000（宪法第 4 条，评分不用浮点） */
    ratingBp: z.number().int().min(0).max(50_000).nullable(),
    reviewCount: z.number().int().min(0).nullable(),
  }),
  output: z.object({ platform: z.string(), onDate: z.string() }),
  permission: 'report.view',
  ai: { description: '（内部）记录平台侧的评分与评价总数。', confirm: 'never', exposed: false },
  reversible: false,
  idempotency: 'optional',
});

export const reviewSentiment = z.enum(['positive', 'neutral', 'negative']);

/** 单条评价的模型分析结果：情感 + 亮点/风险要点。 */
export const SaveReviewAnalysis = defineCommand({
  name: 'reviews.saveAnalysis',
  system: true,
  input: z.object({
    items: z.array(z.object({
      reviewId: uuid,
      sentiment: reviewSentiment,
      highlights: z.array(z.string().min(2).max(120)).max(5),
    })).min(1).max(50),
  }),
  output: z.object({ updated: z.number().int().min(0) }),
  permission: 'report.view',
  ai: { description: '（内部）写入单条评价的情感与要点。', confirm: 'never', exposed: false },
  reversible: false,
  idempotency: 'optional',
});

/**
 * 口碑摘要的落库形状（05 §8.3）。
 *
 * ⚠️ `sentimentScoreBp` 来自 `location_review_stats` 的平台权威分数，
 * **不是模型算的**。有确定答案的数字不交给模型（05 §10.6）。
 */
export const reviewSummaryContentSchema = z.object({
  overview: z.string().min(3).max(600),
  topKeywords: z.array(z.object({
    tag: z.string().min(1).max(60),
    count: z.number().int().min(0),
    sentiment: z.enum(['positive', 'warning', 'neutral']),
  })).max(12),
  actionableSuggestions: z.array(z.object({
    type: z.enum(['warning', 'tip']),
    title: z.string().min(2).max(120),
    description: z.string().min(2).max(400),
  })).max(6),
  keyPositiveThemes: z.array(z.string().min(2).max(120)).max(6),
  keyNegativeThemes: z.array(z.string().min(2).max(120)).max(6),
  sentimentScoreBp: z.number().int().min(0).max(50_000).nullable(),
  /** 摘录占比过高时强制降为 low（05 §8.3） */
  confidence: z.enum(['low', 'medium', 'high']),
});

export const SaveReviewSummary = defineCommand({
  name: 'reviews.saveSummary',
  system: true,
  input: z.object({
    periodStart: z.string().min(8).max(32),
    periodEnd: z.string().min(8).max(32),
    /** 各平台各贡献了几条 —— 老板要知道结论的来源 */
    coverage: z.record(z.number().int().min(0)),
    /** 增量判断依据：最新一条评价的 external_id 没变就不再调模型（05 §8.2） */
    latestReviewId: z.string().max(300).nullable(),
    content: reviewSummaryContentSchema,
    excerptRatioBp: z.number().int().min(0).max(10_000).default(0),
    tokenCostCents: z.number().int().min(0).default(0),
  }),
  output: z.object({ summaryId: uuid, generatedAt: z.string() }),
  permission: 'report.view',
  ai: { description: '（内部）保存本店的 AI 口碑摘要。', confirm: 'never', exposed: false },
  reversible: false,
  idempotency: 'optional',
});

export const REVIEW_COMMANDS = [
  ConfigureReviewSources,
  StartReviewSyncRun,
  AttachSyncSnapshot,
  FinishReviewSyncRun,
  IngestReviews,
  RecordReviewStats,
  SaveReviewAnalysis,
  SaveReviewSummary,
] as const;
