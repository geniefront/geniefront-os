/**
 * 评价的 AI 分析与口碑摘要（05-AI-INTEGRATION §8.2 / §8.3）
 *
 * 两个入口，都是「先查库决定要不要调模型，再调，最后走命令总线落库」：
 *
 *   `analyzeNewReviews`      只处理**还没分析过**的评价（`ai_sentiment is null`）
 *   `generateReviewSummary`  最新一条评价没变就**根本不调模型**
 *
 * ## 降本不是优化，是这条链路能不能开的前提
 *
 * 门店评价的更新频率本来就低。不做增量判断的话，每天的定时任务会把同一批
 * 评价重新喂给模型一遍 —— 一千家店就是一千次没有任何新信息的调用。
 * §8.2 把这一条列在最前面，就是这个原因。
 *
 * ## ⚠️ 模型调用前必须过准入闸门
 *
 * `assertAiAdmission` 挡的是欠费、额度耗尽和限频，必须在**花掉第一个 token
 * 之前**（AUD-03）。后台任务尤其需要它：没有人盯着，一个循环能把一家欠费
 * 门店的余额扣成很深的负数。
 */

import {
  analyzeReviews, clampConfidence, summarizeReviews, REVIEW_MODEL,
  billableTokens, costMillicents, SONNET_5_RATES,
  type ReviewForAnalysis,
} from '@gf/ai';
import { withTenant } from '@gf/db';
import type { CommandContext } from '@gf/contracts';
import { assertAiAdmission } from '../billing/aiAdmission';
import { dispatch } from '../bus';
import '../handlers/reviews';
import '../handlers/ai';

/** 一次最多分析多少条。与 @gf/ai 的工具 schema 上限一致 */
const ANALYZE_BATCH = 25;
/** 摘要覆盖的天数与条数上限 —— 再多对结论没有帮助，只是更贵 */
const SUMMARY_DAYS = 90;
const SUMMARY_LIMIT = 60;

const systemDispatch = <T>(command: string, input: unknown, ctx: CommandContext) =>
  dispatch<T>(command, input, ctx, { systemOrigin: 'anthropic_usage' });

interface ReviewRow {
  id: string;
  platform: string;
  rating: number | null;
  content: string | null;
  is_excerpt: boolean;
  posted_at: string | null;
  external_id: string;
}

const toAnalysisInput = (row: ReviewRow): ReviewForAnalysis => ({
  id: row.id,
  platform: row.platform,
  rating: row.rating,
  content: row.content,
  isExcerpt: row.is_excerpt,
  postedAt: row.posted_at,
});

/**
 * 记一次用量并扣额度。
 *
 * ⚠️ 失败不抛：模型已经调过了、钱已经花出去了，这里抛异常只会让一次
 * 成功的分析被判为失败并在下一轮重跑 —— 那才是真的重复花钱。
 */
async function recordUsage(
  ctx: CommandContext,
  feature: string,
  usage: { tokens: number; costMillicents: number },
  log: { warn: (o: unknown, m: string) => void } | undefined,
): Promise<void> {
  try {
    await systemDispatch('ai.recordAssist', {
      feature, model: REVIEW_MODEL,
      tokens: usage.tokens, costMillicents: usage.costMillicents,
      rounds: 1, hadProposal: false,
    }, ctx);
  } catch (e) {
    log?.warn({ err: e, locationId: ctx.locationId }, 'failed to record review ai usage');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 逐条分析
// ─────────────────────────────────────────────────────────────────────────────

export interface AnalyzeOutcome {
  analyzed: number;
  updated: number;
  state: 'done' | 'nothing_to_do' | 'disabled';
}

export async function analyzeNewReviews(
  ctx: CommandContext,
  opts: { limit?: number; log?: { warn: (o: unknown, m: string) => void } | undefined } = {},
): Promise<AnalyzeOutcome> {
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) return { analyzed: 0, updated: 0, state: 'disabled' };

  const limit = Math.min(opts.limit ?? ANALYZE_BATCH, ANALYZE_BATCH);
  const rows = await withTenant(ctx, (tx) => tx<ReviewRow[]>`
    select id, platform, rating, content, is_excerpt, external_id,
           posted_at::text as posted_at
    from location_reviews
    where location_id = ${ctx.locationId}
      and ai_sentiment is null
      -- 没有正文的评价（纯星级）没有可分析的东西，喂给模型只是白花钱
      and content is not null and length(btrim(content)) > 0
    order by coalesce(posted_at, scraped_at) desc
    limit ${limit}`);

  if (rows.length === 0) return { analyzed: 0, updated: 0, state: 'nothing_to_do' };

  await assertAiAdmission(ctx);
  const result = await analyzeReviews({
    apiKey, reviews: rows.map(toAnalysisInput), locale: ctx.locale,
  });

  await recordUsage(ctx, 'review_analysis', {
    tokens: billableTokens(result.usage),
    costMillicents: costMillicents(result.usage, SONNET_5_RATES),
  }, opts.log);

  if (result.content.items.length === 0) {
    return { analyzed: rows.length, updated: 0, state: 'done' };
  }

  const saved = await systemDispatch<{ updated: number }>('reviews.saveAnalysis', {
    items: result.content.items.map((item) => ({
      reviewId: item.id, sentiment: item.sentiment, highlights: item.highlights,
    })),
  }, ctx);

  return { analyzed: rows.length, updated: saved.result.updated, state: 'done' };
}

// ─────────────────────────────────────────────────────────────────────────────
// 口碑摘要
// ─────────────────────────────────────────────────────────────────────────────

export interface SummaryOutcome {
  state: 'generated' | 'unchanged' | 'no_reviews' | 'disabled';
  summaryId: string | null;
  reviewCount: number;
  excerptRatioBp: number;
}

export async function generateReviewSummary(
  ctx: CommandContext,
  opts: { force?: boolean; log?: { warn: (o: unknown, m: string) => void } | undefined } = {},
): Promise<SummaryOutcome> {
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) {
    return { state: 'disabled', summaryId: null, reviewCount: 0, excerptRatioBp: 0 };
  }

  const { rows, previousLatest, platformScoreBp } = await withTenant(ctx, async (tx) => {
    const rows = await tx<ReviewRow[]>`
      select id, platform, rating, content, is_excerpt, external_id,
             posted_at::text as posted_at
      from location_reviews
      where location_id = ${ctx.locationId}
        and coalesce(posted_at, scraped_at) >= now() - make_interval(days => ${SUMMARY_DAYS})
      order by coalesce(posted_at, scraped_at) desc
      limit ${SUMMARY_LIMIT}`;

    const [previous] = await tx<{ latest_review_id: string | null }[]>`
      select latest_review_id from review_summaries
      where location_id = ${ctx.locationId}
      order by generated_at desc limit 1`;

    /*
     * 平台权威分数：取最近一天有分数的那一条。
     *
     * ⭐ **不让模型算平均分**（05 §8.3）。这里取的是平台自己显示的分数，
     * 它和老板在 Yelp 页面上看到的数字一致；模型按抓到的样本算出来的
     * 平均分必然与之不同，而老板会认为是我们算错了。
     */
    const [stats] = await tx<{ rating_bp: number | null }[]>`
      select rating_bp from location_review_stats
      where location_id = ${ctx.locationId} and rating_bp is not null
      order by on_date desc limit 1`;

    return {
      rows,
      previousLatest: previous?.latest_review_id ?? null,
      platformScoreBp: stats?.rating_bp ?? null,
    };
  });

  if (rows.length === 0) {
    return { state: 'no_reviews', summaryId: null, reviewCount: 0, excerptRatioBp: 0 };
  }

  /*
   * ⭐ 增量判断（05 §8.2）：最新一条评价的 external_id 没变就直接返回，
   * **一个 token 都不花**。门店评价的更新频率很低，这一条能挡掉绝大部分调用。
   */
  const latestReviewId = rows[0]!.external_id;
  if (!opts.force && previousLatest !== null && previousLatest === latestReviewId) {
    return { state: 'unchanged', summaryId: null, reviewCount: rows.length, excerptRatioBp: 0 };
  }

  const excerptCount = rows.filter((row) => row.is_excerpt).length;
  const excerptRatioBp = Math.round((excerptCount / rows.length) * 10_000);
  const periodEnd = new Date();
  const periodStart = new Date(periodEnd.getTime() - SUMMARY_DAYS * 86_400_000);

  await assertAiAdmission(ctx);
  const result = await summarizeReviews({
    apiKey,
    reviews: rows.map(toAnalysisInput),
    periodStart: periodStart.toISOString().slice(0, 10),
    periodEnd: periodEnd.toISOString().slice(0, 10),
    platformScoreBp,
    excerptRatioBp,
    locale: ctx.locale,
  });

  const cost = costMillicents(result.usage, SONNET_5_RATES);
  await recordUsage(ctx, 'review_summary', {
    tokens: billableTokens(result.usage), costMillicents: cost,
  }, opts.log);

  const coverage = rows.reduce<Record<string, number>>((acc, row) => {
    acc[row.platform] = (acc[row.platform] ?? 0) + 1;
    return acc;
  }, {});

  const saved = await systemDispatch<{ summaryId: string }>('reviews.saveSummary', {
    periodStart: periodStart.toISOString().slice(0, 10),
    periodEnd: periodEnd.toISOString().slice(0, 10),
    coverage,
    latestReviewId,
    content: {
      ...result.content,
      // 分数来自平台，不是模型（05 §8.3）
      sentimentScoreBp: platformScoreBp,
      // 摘录占比过高或样本太少时强制降级，老板端据此显示「样本不完整」
      confidence: clampConfidence(result.content.confidence, excerptRatioBp, rows.length),
    },
    excerptRatioBp,
    // review_summaries.token_cost_cents 存整数分：毫分四舍五入
    tokenCostCents: Math.round(cost / 1000),
  }, ctx);

  return {
    state: 'generated',
    summaryId: saved.result.summaryId,
    reviewCount: rows.length,
    excerptRatioBp,
  };
}
