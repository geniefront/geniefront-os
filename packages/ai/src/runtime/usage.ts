/**
 * 供应商无关的用量归一化与计费适配器 (29 §12.1)
 */

import { LUNA_RATES } from './config.js';
import type { ModelRates } from '../cost.js';

export type { ModelRates };

export interface NormalizedUsage {
  /** 未命中缓存的输入 Token 数 (prompt_tokens - cached_tokens) */
  uncachedInputTokens: number;
  /** 命中缓存的输入 Token 数 (prompt_tokens_details.cached_tokens) */
  cachedReadInputTokens: number;
  /** 输出 Token 数 (completion_tokens) */
  outputTokens: number;
  /** 包含在 outputTokens 内的推理 Token 数 (供审计与分析) */
  reasoningTokens?: number | undefined;
}

/**
 * 将 OpenAI API / Responses API 返回的原始 usage 结构归一化。
 *
 * ⚠️ 关键差异防坑：
 * OpenAI 的 `prompt_tokens` 已经包含了 `prompt_tokens_details.cached_tokens`。
 * 必须执行 `uncachedInputTokens = prompt_tokens - cached_tokens`，
 * 严禁直接相加导致虚高计费。
 */
export function normalizeOpenAiUsage(raw: {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
  completion_tokens_details?: {
    reasoning_tokens?: number;
  };
} | null | undefined): NormalizedUsage {
  if (!raw) {
    return {
      uncachedInputTokens: 0,
      cachedReadInputTokens: 0,
      outputTokens: 0,
    };
  }

  const promptTotal = Math.max(0, Math.floor(raw.prompt_tokens ?? 0));
  const cached = Math.max(0, Math.floor(raw.prompt_tokens_details?.cached_tokens ?? 0));
  const outputTokens = Math.max(0, Math.floor(raw.completion_tokens ?? 0));
  const uncachedInputTokens = Math.max(0, promptTotal - cached);
  const reasoningTokens = raw.completion_tokens_details?.reasoning_tokens !== undefined
    ? Math.max(0, Math.floor(raw.completion_tokens_details.reasoning_tokens))
    : undefined;

  return {
    uncachedInputTokens,
    cachedReadInputTokens: cached,
    outputTokens,
    reasoningTokens,
  };
}

/**
 * 依据费率计算产生的毫分 (1/1000 美分)。整数运算，向上取整。
 */
export function costMillicentsNormalized(
  u: NormalizedUsage,
  rates: ModelRates = LUNA_RATES,
): number {
  const parts =
    u.uncachedInputTokens * rates.inputPerMTok +
    u.outputTokens * rates.outputPerMTok +
    u.cachedReadInputTokens * rates.cacheReadPerMTok;
  return Math.ceil(parts / 1_000_000);
}

/**
 * 计费与审计使用的总 Token 数
 */
export function billableTokensNormalized(u: NormalizedUsage): number {
  return u.uncachedInputTokens + u.cachedReadInputTokens + u.outputTokens;
}

/**
 * 累加多次调用的用量
 */
export function sumNormalizedUsage(list: readonly NormalizedUsage[]): NormalizedUsage {
  return list.reduce<NormalizedUsage>(
    (acc, curr) => ({
      uncachedInputTokens: acc.uncachedInputTokens + curr.uncachedInputTokens,
      cachedReadInputTokens: acc.cachedReadInputTokens + curr.cachedReadInputTokens,
      outputTokens: acc.outputTokens + curr.outputTokens,
      reasoningTokens:
        acc.reasoningTokens !== undefined || curr.reasoningTokens !== undefined
          ? (acc.reasoningTokens ?? 0) + (curr.reasoningTokens ?? 0)
          : undefined,
    }),
    {
      uncachedInputTokens: 0,
      cachedReadInputTokens: 0,
      outputTokens: 0,
    },
  );
}
