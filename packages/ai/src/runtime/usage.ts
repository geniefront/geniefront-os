/**
 * 供应商无关的用量归一化与计费适配器 (29 §12.1)
 */

import {
  LUNA_RATES,
  LUNA_LONG_CONTEXT_RATES,
  LUNA_LONG_CONTEXT_THRESHOLD_TOKENS,
} from './config.js';
import type { ModelRates } from '../cost.js';

export type { ModelRates };

export interface NormalizedUsage {
  /** 未命中缓存、也没写入缓存的输入 Token（按 input 价） */
  uncachedInputTokens: number;
  /** 命中缓存读取的输入 Token（按 cached input 价，0.1 倍） */
  cachedReadInputTokens: number;
  /** 本次写入缓存的输入 Token（按 cache write 价，1.25 倍） */
  cacheWriteInputTokens: number;
  /** 输出 Token 数 */
  outputTokens: number;
  /** 包含在 outputTokens 内的推理 Token 数（供审计与分析，不重复计价） */
  reasoningTokens?: number | undefined;
}

/**
 * 将模型返回的原始 usage 结构归一化。
 *
 * ## ⚠️ Responses API 和 Chat Completions 的字段名完全是两套
 *
 * 这里以前**只认 Chat Completions 那一套**（`prompt_tokens` /
 * `completion_tokens` / `prompt_tokens_details`），而运行时走的是
 * Responses API，它回的是 `input_tokens` / `output_tokens` /
 * `input_tokens_details`。字段名对不上 → 每一项都读成 0 → 用量落库全是 0、
 * 成本算出来是 0、积分一分不扣。而且因为读的是可选字段，
 * TypeScript 和运行时都不会报错，是那种只能靠对账发现的静默故障。
 *
 * 实测（gpt-5.6-luna，2026-09-06）Responses API 的形状：
 * ```json
 * { "input_tokens": 12,
 *   "input_tokens_details": { "cached_tokens": 0, "cache_write_tokens": 0 },
 *   "output_tokens": 9,
 *   "output_tokens_details": { "reasoning_tokens": 0 },
 *   "total_tokens": 21 }
 * ```
 *
 * ## 输入的三段拆分
 *
 * `input_tokens` 是**总数**，`cached_tokens` 与 `cache_write_tokens` 都是它的
 * 子集。三个价位各不相同（读 0.1 倍 / 写 1.25 倍 / 普通 1 倍），所以必须减出
 * 互不重叠的三段再分别计价。直接相加会虚高计费 —— 那是在多扣客户的钱。
 */
export function normalizeOpenAiUsage(raw: {
  // Responses API
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
  };
  output_tokens_details?: {
    reasoning_tokens?: number;
  };
  // Chat Completions（兼容旧调用点）
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
  };
  completion_tokens_details?: {
    reasoning_tokens?: number;
  };
  total_tokens?: number;
} | null | undefined): NormalizedUsage {
  const empty: NormalizedUsage = {
    uncachedInputTokens: 0,
    cachedReadInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
  };
  if (!raw) return empty;

  const int = (v: unknown) => Math.max(0, Math.floor(Number(v ?? 0)) || 0);

  const inputDetails = raw.input_tokens_details ?? raw.prompt_tokens_details;
  const outputDetails = raw.output_tokens_details ?? raw.completion_tokens_details;

  const inputTotal = int(raw.input_tokens ?? raw.prompt_tokens);
  const cachedRead = Math.min(inputTotal, int(inputDetails?.cached_tokens));
  const cacheWrite = Math.min(inputTotal - cachedRead, int(inputDetails?.cache_write_tokens));
  const outputTokens = int(raw.output_tokens ?? raw.completion_tokens);

  const reasoningRaw = outputDetails?.reasoning_tokens;

  return {
    uncachedInputTokens: Math.max(0, inputTotal - cachedRead - cacheWrite),
    cachedReadInputTokens: cachedRead,
    cacheWriteInputTokens: cacheWrite,
    outputTokens,
    ...(reasoningRaw !== undefined ? { reasoningTokens: int(reasoningRaw) } : {}),
  };
}

/**
 * 挑选计价档位。
 *
 * Luna 的长上下文不是「超出的那部分加价」，而是**整单换档**：
 * 输入总量（含命中缓存的部分）一旦越过阈值，整个请求的 input 按 2 倍、
 * output 按 1.5 倍计。所以判断依据是 uncached + cached 的和，
 * 不能只看没命中缓存的那部分。
 */
export function ratesForUsage(u: NormalizedUsage): ModelRates {
  const inputTotal =
    u.uncachedInputTokens + u.cachedReadInputTokens + u.cacheWriteInputTokens;
  return inputTotal > LUNA_LONG_CONTEXT_THRESHOLD_TOKENS
    ? LUNA_LONG_CONTEXT_RATES
    : LUNA_RATES;
}

/**
 * 依据费率计算产生的毫分 (1/1000 美分)。整数运算，向上取整。
 *
 * 不传 rates 时按输入量自动选短 / 长上下文档位。
 * 输入的三段（普通 / 缓存读 / 缓存写）各按各的价，互不重叠。
 */
export function costMillicentsNormalized(
  u: NormalizedUsage,
  rates: ModelRates = ratesForUsage(u),
): number {
  const parts =
    u.uncachedInputTokens * rates.inputPerMTok +
    u.cachedReadInputTokens * rates.cacheReadPerMTok +
    u.cacheWriteInputTokens * rates.cacheWritePerMTok +
    u.outputTokens * rates.outputPerMTok;
  return Math.ceil(parts / 1_000_000);
}

/**
 * 计费与审计使用的总 Token 数
 */
export function billableTokensNormalized(u: NormalizedUsage): number {
  return u.uncachedInputTokens + u.cachedReadInputTokens
    + u.cacheWriteInputTokens + u.outputTokens;
}

/**
 * 累加多次调用的用量
 */
export function sumNormalizedUsage(list: readonly NormalizedUsage[]): NormalizedUsage {
  return list.reduce<NormalizedUsage>(
    (acc, curr) => ({
      uncachedInputTokens: acc.uncachedInputTokens + curr.uncachedInputTokens,
      cachedReadInputTokens: acc.cachedReadInputTokens + curr.cachedReadInputTokens,
      cacheWriteInputTokens: acc.cacheWriteInputTokens + curr.cacheWriteInputTokens,
      outputTokens: acc.outputTokens + curr.outputTokens,
      reasoningTokens:
        acc.reasoningTokens !== undefined || curr.reasoningTokens !== undefined
          ? (acc.reasoningTokens ?? 0) + (curr.reasoningTokens ?? 0)
          : undefined,
    }),
    {
      uncachedInputTokens: 0,
      cachedReadInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 0,
    },
  );
}
