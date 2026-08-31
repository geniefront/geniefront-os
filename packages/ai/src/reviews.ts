/**
 * 外部评价的情感分析与口碑摘要（05-AI-INTEGRATION §8.3）
 *
 * 两个函数，分工刻意分开：
 *
 *   `analyzeReviews`   逐条判情感与要点 —— 结果进 `location_reviews.ai_sentiment`
 *                      与 `ai_highlights`，老板端每条评价旁边那个标签靠它
 *   `summarizeReviews` 归纳整段时间的主题与建议 —— 结果进 `review_summaries`
 *
 * ## ⭐ 两条纪律，违反任何一条这个模块就没有意义
 *
 * 1. **截断正文必须逐条标注**。Yelp Fusion 给的正文经常断在半句话上，
 *    不告诉模型的话它会对着被切掉的句子下结论（例如把
 *    「前台说十五分钟但是」判成中性）。标注写在每条正文的前缀里，
 *    系统提示里再重申一次。
 *
 * 2. **平均分不交给模型算**。`sentimentScoreBp` 来自
 *    `location_review_stats` 里平台给的权威分数，模型只负责归纳主题。
 *    有确定答案的数字不交给模型（05 §10.6）。
 */

import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { sumUsage, type TokenUsage } from './cost';

/** 非实时、容错率高、可自动重试的分析任务 —— 用 sonnet（05 §8.3 末） */
export const REVIEW_MODEL = 'claude-sonnet-5';

export interface ReviewForAnalysis {
  /** `location_reviews.id`。模型的输出要按它回填，不能靠顺序对齐 */
  id: string;
  platform: string;
  rating: number | null;
  content: string | null;
  /** ⚠️ true = 正文被平台截断，提示词里必须标出来 */
  isExcerpt: boolean;
  postedAt: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 逐条分析
// ─────────────────────────────────────────────────────────────────────────────

export const reviewAnalysisSchema = z.object({
  items: z.array(z.object({
    id: z.string().min(1),
    sentiment: z.enum(['positive', 'neutral', 'negative']),
    highlights: z.array(z.string().min(2).max(120)).max(5),
  })).max(50),
});

export type ReviewAnalysis = z.infer<typeof reviewAnalysisSchema>;

const analysisTool: Anthropic.Tool = {
  name: 'record_review_analysis',
  description: 'Record per-review sentiment and short highlight phrases.',
  input_schema: {
    type: 'object', additionalProperties: false, required: ['items'],
    properties: {
      items: {
        type: 'array', maxItems: 50,
        items: {
          type: 'object', additionalProperties: false,
          required: ['id', 'sentiment', 'highlights'],
          properties: {
            id: { type: 'string', description: 'The exact review id given in the input.' },
            sentiment: { type: 'string', enum: ['positive', 'neutral', 'negative'] },
            highlights: {
              type: 'array', maxItems: 5,
              items: { type: 'string' },
              description: 'Short noun phrases naming what the guest praised or complained about.',
            },
          },
        },
      },
    },
  },
};

const ANALYSIS_SYSTEM = [
  'You label salon and spa guest reviews for an operations dashboard.',
  'Rules you must follow:',
  '1. A review marked [excerpt · truncated] was cut off by the platform.',
  '   Judge only the visible words; never infer how the sentence would have ended.',
  '2. Sentiment follows the written text, not the star rating alone.',
  '   When text and stars disagree, trust the text and prefer "neutral" over guessing.',
  '3. Highlights are short concrete phrases (a service, a technician, wait time, cleanliness).',
  '   Do not invent details that are not in the text. An empty list is a valid answer.',
  '4. Echo back the exact id you were given for each review.',
].join('\n');

function renderReview(review: ReviewForAnalysis): string {
  const stars = review.rating === null ? '★?' : `★${review.rating}`;
  // ⭐ 截断标记与平台一起放在正文前缀里。放在别处（例如单独一个字段）
  // 模型很容易在长上下文里漏看，而漏看的后果正是这个标记要防的事
  const tag = review.isExcerpt ? `${review.platform} · excerpt · truncated` : `${review.platform} · full`;
  const body = review.content?.trim() ?? '(no text)';
  return `[${review.id}] [${tag}] ${stars} "${body}"`;
}

export async function analyzeReviews(opts: {
  apiKey: string;
  reviews: readonly ReviewForAnalysis[];
  locale: string;
  client?: Anthropic;
}): Promise<{ content: ReviewAnalysis; model: string; usage: TokenUsage }> {
  const client = opts.client
    ?? new Anthropic({ apiKey: opts.apiKey, timeout: 60_000, maxRetries: 1 });

  const message = await client.messages.create({
    model: REVIEW_MODEL,
    max_tokens: 2_000,
    system: ANALYSIS_SYSTEM,
    tools: [analysisTool],
    tool_choice: { type: 'tool', name: analysisTool.name },
    messages: [{
      role: 'user',
      content: `Write highlight phrases in locale ${opts.locale}. Label these reviews:\n`
        + opts.reviews.map(renderReview).join('\n'),
    }],
  });

  const usage = usageOf(message);
  if (message.stop_reason === 'refusal') throw new Error('review_analysis_refused');
  const block = message.content.find(
    (item) => item.type === 'tool_use' && item.name === analysisTool.name);
  if (!block || block.type !== 'tool_use') throw new Error('review_analysis_missing_tool_output');

  const parsed = reviewAnalysisSchema.safeParse(block.input);
  if (!parsed.success) throw new Error('review_analysis_invalid_output');

  /*
   * 只保留输入里真实存在的 id。
   *
   * 模型偶尔会改写 id（补零、去掉连字符），而 `reviews.saveAnalysis` 的
   * 写入是按 id 定位的 —— 认不出的 id 会静默更新到零行，表现为
   * 「分析跑了但页面上什么都没变」。在这里挡掉，调用方才能看到差额。
   */
  const known = new Set(opts.reviews.map((r) => r.id));
  return {
    content: { items: parsed.data.items.filter((item) => known.has(item.id)) },
    model: REVIEW_MODEL,
    usage,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 口碑摘要
// ─────────────────────────────────────────────────────────────────────────────

export const reviewSummarySchema = z.object({
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
  confidence: z.enum(['low', 'medium', 'high']),
});

export type ReviewSummary = z.infer<typeof reviewSummarySchema>;

const summaryTool: Anthropic.Tool = {
  name: 'record_review_summary',
  description: 'Record an evidence-based reputation summary for one salon location.',
  input_schema: {
    type: 'object', additionalProperties: false,
    required: ['overview', 'topKeywords', 'actionableSuggestions',
      'keyPositiveThemes', 'keyNegativeThemes', 'confidence'],
    properties: {
      overview: { type: 'string' },
      topKeywords: {
        type: 'array', maxItems: 12,
        items: {
          type: 'object', additionalProperties: false,
          required: ['tag', 'count', 'sentiment'],
          properties: {
            tag: { type: 'string' },
            count: { type: 'integer', description: 'How many reviews mention this theme.' },
            sentiment: { type: 'string', enum: ['positive', 'warning', 'neutral'] },
          },
        },
      },
      actionableSuggestions: {
        type: 'array', maxItems: 6,
        items: {
          type: 'object', additionalProperties: false,
          required: ['type', 'title', 'description'],
          properties: {
            type: { type: 'string', enum: ['warning', 'tip'] },
            title: { type: 'string' },
            description: { type: 'string' },
          },
        },
      },
      keyPositiveThemes: { type: 'array', maxItems: 6, items: { type: 'string' } },
      keyNegativeThemes: { type: 'array', maxItems: 6, items: { type: 'string' } },
      confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    },
  },
};

const SUMMARY_SYSTEM = [
  'You are a salon operations analyst summarizing public guest reviews.',
  'Rules you must follow:',
  '1. Reviews marked [excerpt · truncated] were cut off by the platform.',
  '   Never infer the missing half of a sentence, and never build a theme on one alone.',
  '2. Do not compute or state an average rating. The platform score is supplied separately',
  '   and is authoritative; your job is themes and actions, not arithmetic.',
  '3. Every theme and suggestion must trace to wording that actually appears in the reviews.',
  '4. Suggestions are things a shop owner can act on this week (staffing, scheduling,',
  '   cleanliness, communication). No marketing slogans.',
  '5. Set confidence to "low" when the sample is small or mostly truncated excerpts.',
].join('\n');

export async function summarizeReviews(opts: {
  apiKey: string;
  reviews: readonly ReviewForAnalysis[];
  periodStart: string;
  periodEnd: string;
  /** 平台权威分数（basis point）。给模型看是为了让它的措辞不和分数打架 */
  platformScoreBp: number | null;
  /** 摘录占比（basis point）。超过阈值时结论要降级 */
  excerptRatioBp: number;
  locale: string;
  client?: Anthropic;
}): Promise<{ content: ReviewSummary; model: string; usage: TokenUsage }> {
  const client = opts.client
    ?? new Anthropic({ apiKey: opts.apiKey, timeout: 90_000, maxRetries: 1 });

  const score = opts.platformScoreBp === null
    ? 'not available'
    : (opts.platformScoreBp / 10_000).toFixed(2);

  const message = await client.messages.create({
    model: REVIEW_MODEL,
    max_tokens: 2_000,
    system: SUMMARY_SYSTEM,
    tools: [summaryTool],
    tool_choice: { type: 'tool', name: summaryTool.name },
    messages: [{
      role: 'user',
      content: [
        `Write all text in locale ${opts.locale}.`,
        `Period: ${opts.periodStart} to ${opts.periodEnd}.`,
        `Authoritative platform score: ${score} (do not recompute it).`,
        `${(opts.excerptRatioBp / 100).toFixed(1)}% of the reviews below are truncated excerpts.`,
        '',
        ...opts.reviews.map(renderReview),
      ].join('\n'),
    }],
  });

  const usage = usageOf(message);
  if (message.stop_reason === 'refusal') throw new Error('review_summary_refused');
  const block = message.content.find(
    (item) => item.type === 'tool_use' && item.name === summaryTool.name);
  if (!block || block.type !== 'tool_use') throw new Error('review_summary_missing_tool_output');

  const parsed = reviewSummarySchema.safeParse(block.input);
  if (!parsed.success) throw new Error('review_summary_invalid_output');

  return { content: parsed.data, model: REVIEW_MODEL, usage };
}

/**
 * 摘录占比超过阈值时把置信度压到 low（05 §8.3）。
 *
 * 这一条不交给模型自觉执行：它拿到的提示里已经写了同样的规则，但
 * 「一半以上样本是残缺的」是一个可以直接算出来的判据 ——
 * 能算的东西不该有第二种答案。老板端据此显示「样本不完整，仅供参考」。
 */
export const EXCERPT_RATIO_LOW_CONFIDENCE_BP = 5_000;

export function clampConfidence(
  confidence: ReviewSummary['confidence'],
  excerptRatioBp: number,
  reviewCount: number,
): ReviewSummary['confidence'] {
  if (excerptRatioBp >= EXCERPT_RATIO_LOW_CONFIDENCE_BP) return 'low';
  // 样本太少时同理：三条评价归纳不出「周末等位久」这种结论
  if (reviewCount < 5) return 'low';
  return confidence;
}

function usageOf(message: Anthropic.Message): TokenUsage {
  return sumUsage([{
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
    cacheReadInputTokens: message.usage.cache_read_input_tokens ?? 0,
    cacheCreationInputTokens: message.usage.cache_creation_input_tokens ?? 0,
  }]);
}
