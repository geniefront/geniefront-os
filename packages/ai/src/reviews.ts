/**
 * 外部评价的情感分析与口碑摘要（05-AI-INTEGRATION §8.3, 29 §12.2）
 *
 * 两个函数，分工刻意分开：
 *   `analyzeReviews`   逐条判情感与要点 —— 结果进 `location_reviews.ai_sentiment`
 *   `summarizeReviews` 归纳整段时间的主题与建议 —— 结果进 `review_summaries`
 */

import { z } from 'zod';
import { sumUsage, type TokenUsage } from './cost';
import {
  LunaRuntime,
  getLunaRuntime,
  type LunaTool,
  type LunaResponse,
} from './runtime/luna';
import { LUNA_MODEL, LUNA_TIMEOUTS } from './runtime/config';

export const REVIEW_MODEL = LUNA_MODEL;

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

const analysisTool: LunaTool = {
  name: 'record_review_analysis',
  description: 'Record per-review sentiment and short highlight phrases.',
  parameters: {
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
  strict: true,
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
  const tag = review.isExcerpt ? `${review.platform} · excerpt · truncated` : `${review.platform} · full`;
  const body = review.content?.trim() ?? '(no text)';
  return `[${review.id}] [${tag}] ${stars} "${body}"`;
}

export async function analyzeReviews(opts: {
  apiKey?: string | undefined;
  reviews: readonly ReviewForAnalysis[];
  locale: string;
  runtime?: LunaRuntime | undefined;
  client?: any | undefined;
}): Promise<{ content: ReviewAnalysis; model: string; usage: TokenUsage }> {
  if (opts.client && typeof opts.client.messages?.create === 'function') {
    const message = await opts.client.messages.create({
      model: 'claude-sonnet-5',
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
    if (message.stop_reason === 'refusal') throw new Error('review_analysis_refused');
    const block = message.content.find((item: any) => item.type === 'tool_use' && item.name === analysisTool.name);
    if (!block || block.type !== 'tool_use') throw new Error('review_analysis_missing_tool_output');
    const parsed = reviewAnalysisSchema.safeParse(block.input);
    if (!parsed.success) throw new Error('review_analysis_invalid_output');
    const known = new Set(opts.reviews.map((r) => r.id));
    return {
      content: { items: parsed.data.items.filter((item) => known.has(item.id)) },
      model: 'claude-sonnet-5',
      usage: {
        inputTokens: message.usage?.input_tokens ?? 0,
        outputTokens: message.usage?.output_tokens ?? 0,
      },
    };
  }

  const runtime = opts.runtime ?? (opts.apiKey ? new LunaRuntime(opts.apiKey) : getLunaRuntime());
  const response: LunaResponse = await runtime.invoke({
    instructions: ANALYSIS_SYSTEM,
    messages: [{
      role: 'user',
      content: `Write highlight phrases in locale ${opts.locale}. Label these reviews:\n`
        + opts.reviews.map(renderReview).join('\n'),
    }],
    tools: [analysisTool],
    toolChoice: { type: 'function', name: analysisTool.name },
    effort: 'low',
    maxOutputTokens: 2_000,
    timeoutMs: LUNA_TIMEOUTS.FAST_MS,
  });

  const usage: TokenUsage = {
    inputTokens: response.usage.uncachedInputTokens,
    outputTokens: response.usage.outputTokens,
    cacheReadInputTokens: response.usage.cachedReadInputTokens,
    cacheCreationInputTokens: 0,
  };

  if (response.status === 'refusal') throw new Error('review_analysis_refused');
  const toolCall = response.toolCalls.find((t) => t.name === analysisTool.name);
  if (!toolCall) throw new Error('review_analysis_missing_tool_output');

  const parsed = reviewAnalysisSchema.safeParse(toolCall.arguments);
  if (!parsed.success) throw new Error('review_analysis_invalid_output');

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

const summaryTool: LunaTool = {
  name: 'record_review_summary',
  description: 'Record an evidence-based reputation summary for one salon location.',
  parameters: {
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
  strict: true,
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
  apiKey?: string | undefined;
  reviews: readonly ReviewForAnalysis[];
  periodStart: string;
  periodEnd: string;
  platformScoreBp: number | null;
  excerptRatioBp: number;
  locale: string;
  runtime?: LunaRuntime | undefined;
  client?: any | undefined;
}): Promise<{ content: ReviewSummary; model: string; usage: TokenUsage }> {
  const score = opts.platformScoreBp === null
    ? 'not available'
    : (opts.platformScoreBp / 10_000).toFixed(2);

  const promptContent = [
    `Write all text in locale ${opts.locale}.`,
    `Period: ${opts.periodStart} to ${opts.periodEnd}.`,
    `Authoritative platform score: ${score} (do not recompute it).`,
    `${(opts.excerptRatioBp / 100).toFixed(1)}% of the reviews below are truncated excerpts.`,
    '',
    ...opts.reviews.map(renderReview),
  ].join('\n');

  if (opts.client && typeof opts.client.messages?.create === 'function') {
    const message = await opts.client.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 2_000,
      system: SUMMARY_SYSTEM,
      tools: [summaryTool],
      tool_choice: { type: 'tool', name: summaryTool.name },
      messages: [{ role: 'user', content: promptContent }],
    });
    if (message.stop_reason === 'refusal') throw new Error('review_summary_refused');
    const block = message.content.find((item: any) => item.type === 'tool_use' && item.name === summaryTool.name);
    if (!block || block.type !== 'tool_use') throw new Error('review_summary_missing_tool_output');
    const parsed = reviewSummarySchema.safeParse(block.input);
    if (!parsed.success) throw new Error('review_summary_invalid_output');
    return {
      content: parsed.data,
      model: 'claude-sonnet-5',
      usage: {
        inputTokens: message.usage?.input_tokens ?? 0,
        outputTokens: message.usage?.output_tokens ?? 0,
      },
    };
  }

  const runtime = opts.runtime ?? (opts.apiKey ? new LunaRuntime(opts.apiKey) : getLunaRuntime());
  const response: LunaResponse = await runtime.invoke({
    instructions: SUMMARY_SYSTEM,
    messages: [{ role: 'user', content: promptContent }],
    tools: [summaryTool],
    toolChoice: { type: 'function', name: summaryTool.name },
    effort: 'low',
    maxOutputTokens: 2_000,
    timeoutMs: LUNA_TIMEOUTS.FAST_MS,
  });

  const usage: TokenUsage = {
    inputTokens: response.usage.uncachedInputTokens,
    outputTokens: response.usage.outputTokens,
    cacheReadInputTokens: response.usage.cachedReadInputTokens,
    cacheCreationInputTokens: 0,
  };

  if (response.status === 'refusal') throw new Error('review_summary_refused');
  const toolCall = response.toolCalls.find((t) => t.name === summaryTool.name);
  if (!toolCall) throw new Error('review_summary_missing_tool_output');

  const parsed = reviewSummarySchema.safeParse(toolCall.arguments);
  if (!parsed.success) throw new Error('review_summary_invalid_output');

  return { content: parsed.data, model: REVIEW_MODEL, usage };
}

export const EXCERPT_RATIO_LOW_CONFIDENCE_BP = 5_000;

export function clampConfidence(
  confidence: ReviewSummary['confidence'],
  excerptRatioBp: number,
  reviewCount: number,
): ReviewSummary['confidence'] {
  if (excerptRatioBp >= EXCERPT_RATIO_LOW_CONFIDENCE_BP) return 'low';
  if (reviewCount < 5) return 'low';
  return confidence;
}
