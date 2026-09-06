/**
 * 计费归一化测试。
 *
 * 这一层的错会直接变成**从门店 AI 额度里多扣或少扣的钱**
 * （`costMillicentsNormalized` → `maybeAutoTopup`），所以每一条都对着
 * 官方价目表算一遍真实金额，而不是只测「函数返回了个数」。
 *
 * 参照 developers.openai.com/api/docs/pricing (gpt-5.6-luna, 2026-09-06)：
 *   短档 input $0.20 / cached $0.02 / output $1.20  每百万 token
 *   长档 input $0.40 / cached $0.04 / output $1.80  每百万 token（>272K 整单换档）
 */

import { describe, expect, it } from 'vitest';
import {
  normalizeOpenAiUsage,
  costMillicentsNormalized,
  ratesForUsage,
  billableTokensNormalized,
  sumNormalizedUsage,
} from './usage';
import {
  LUNA_RATES,
  LUNA_LONG_CONTEXT_RATES,
  LUNA_LONG_CONTEXT_THRESHOLD_TOKENS,
} from './config';

/** 毫分 → 美元，用于把断言写成人看得懂的金额 */
const dollars = (millicents: number) => millicents / 100_000;

describe('normalizeOpenAiUsage', () => {
  it('⭐ 认得 Responses API 的字段名 —— 这一条挡的是「用量整体读成 0」', () => {
    // 实测形状（gpt-5.6-luna，2026-09-06）。运行时走的是 Responses API，
    // 早先这里只认 Chat Completions 的 prompt_tokens/completion_tokens，
    // 于是每一项都归零：用量不落库、成本算成 0、积分一分不扣。
    const u = normalizeOpenAiUsage({
      input_tokens: 40_000,
      input_tokens_details: { cached_tokens: 30_000, cache_write_tokens: 6_000 },
      output_tokens: 1_200,
      output_tokens_details: { reasoning_tokens: 400 },
      total_tokens: 41_200,
    });
    expect(u).toEqual({
      uncachedInputTokens: 4_000,
      cachedReadInputTokens: 30_000,
      cacheWriteInputTokens: 6_000,
      outputTokens: 1_200,
      reasoningTokens: 400,
    });
    expect(billableTokensNormalized(u)).toBe(41_200);
  });

  it('⭐ 输入三段互不重叠 —— cached 与 cache_write 都是 input_tokens 的子集', () => {
    const u = normalizeOpenAiUsage({
      input_tokens: 1_000,
      input_tokens_details: { cached_tokens: 600, cache_write_tokens: 300 },
      output_tokens: 0,
    });
    expect(u.uncachedInputTokens + u.cachedReadInputTokens + u.cacheWriteInputTokens)
      .toBe(1_000);
  });

  it('上游给出自相矛盾的数字时夹住，绝不产生负数计费', () => {
    const u = normalizeOpenAiUsage({
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 90, cache_write_tokens: 90 },
      output_tokens: 0,
    });
    expect(u.uncachedInputTokens).toBe(0);
    expect(u.cachedReadInputTokens).toBe(90);
    expect(u.cacheWriteInputTokens).toBe(10);
  });

  it('缓存写入按 1.25 倍单独计价，不再混进普通 input', () => {
    // 1M cache-write @ $0.25 —— 显式钉短档，1M 已越过 272K 阈值
    expect(costMillicentsNormalized({
      uncachedInputTokens: 0, cachedReadInputTokens: 0,
      cacheWriteInputTokens: 1_000_000, outputTokens: 0,
    }, LUNA_RATES) / 100_000).toBeCloseTo(0.25, 6);
  });

  it('Chat Completions 的旧字段名仍然认（其余调用点还在用）', () => {
    const u = normalizeOpenAiUsage({
      prompt_tokens: 50_000,
      completion_tokens: 800,
      prompt_tokens_details: { cached_tokens: 45_000 },
    });
    expect(u.uncachedInputTokens).toBe(5_000);
    expect(u.cachedReadInputTokens).toBe(45_000);
    // 相加会变成 95,000 —— 那是虚高计费
    expect(billableTokensNormalized(u)).toBe(50_800);
  });

  it('缺字段或 usage 为空时全部归零，不抛异常', () => {
    expect(normalizeOpenAiUsage(null)).toEqual({
      uncachedInputTokens: 0, cachedReadInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0,
    });
    expect(normalizeOpenAiUsage({}).uncachedInputTokens).toBe(0);
  });

  it('推理 token 单独记录，但已包含在 outputTokens 内不重复计价', () => {
    const u = normalizeOpenAiUsage({
      prompt_tokens: 100,
      completion_tokens: 900,
      completion_tokens_details: { reasoning_tokens: 600 },
    });
    expect(u.outputTokens).toBe(900);
    expect(u.reasoningTokens).toBe(600);
    // 900 output tokens @ $1.20/MTok = $0.00108
    expect(dollars(costMillicentsNormalized(u))).toBeCloseTo(0.00108 + 0.00002, 6);
  });
});

describe('ratesForUsage 档位选择', () => {
  it('常规副驾一轮（前置全量上下文约 5 万 token）走短档', () => {
    expect(ratesForUsage({
      uncachedInputTokens: 50_000, cachedReadInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 1_000,
    })).toBe(LUNA_RATES);
  });

  it('⭐ 换档看的是 uncached + cached 的和 —— 缓存命中不能让整单逃掉长档', () => {
    const justOver = {
      uncachedInputTokens: 2_000,
      cachedReadInputTokens: LUNA_LONG_CONTEXT_THRESHOLD_TOKENS - 1_000,
      cacheWriteInputTokens: 0,
      outputTokens: 500,
    };
    expect(ratesForUsage(justOver)).toBe(LUNA_LONG_CONTEXT_RATES);
  });

  it('刚好等于阈值仍是短档（官方写的是 >272K）', () => {
    expect(ratesForUsage({
      uncachedInputTokens: LUNA_LONG_CONTEXT_THRESHOLD_TOKENS,
      cachedReadInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 0,
    })).toBe(LUNA_RATES);
  });

  it('长档正好是 input 2 倍、output 1.5 倍', () => {
    expect(LUNA_LONG_CONTEXT_RATES.inputPerMTok).toBe(LUNA_RATES.inputPerMTok * 2);
    expect(LUNA_LONG_CONTEXT_RATES.cacheReadPerMTok).toBe(LUNA_RATES.cacheReadPerMTok * 2);
    expect(LUNA_LONG_CONTEXT_RATES.outputPerMTok).toBe(LUNA_RATES.outputPerMTok * 1.5);
  });
});

describe('costMillicentsNormalized 对账', () => {
  // 这三条测的是费率算术本身，所以显式钉住短档 ——
  // 一百万 token 早就越过 272K 阈值了，不指定档位会自动换成长档。
  it('⭐ 一百万纯 input token 恰好是 $0.20', () => {
    expect(dollars(costMillicentsNormalized({
      uncachedInputTokens: 1_000_000, cachedReadInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0,
    }, LUNA_RATES))).toBeCloseTo(0.20, 6);
  });

  it('⭐ 一百万纯 output token 恰好是 $1.20', () => {
    expect(dollars(costMillicentsNormalized({
      uncachedInputTokens: 0, cachedReadInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 1_000_000,
    }, LUNA_RATES))).toBeCloseTo(1.20, 6);
  });

  it('⭐ 缓存命中按 0.1 倍计 —— 门店档案进前缀缓存的收益全在这一条上', () => {
    const cold = costMillicentsNormalized({
      uncachedInputTokens: 200_000, cachedReadInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0,
    });
    const warm = costMillicentsNormalized({
      uncachedInputTokens: 0, cachedReadInputTokens: 200_000, cacheWriteInputTokens: 0, outputTokens: 0,
    });
    expect(warm * 10).toBe(cold);
  });

  it('典型一轮副驾（5 万 input 全未命中 + 1500 output）不到半分钱', () => {
    const cents = costMillicentsNormalized({
      uncachedInputTokens: 50_000, cachedReadInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 1_500,
    }) / 1_000;
    expect(cents).toBeLessThan(1.5);
  });

  it('超过 272K 时整单换档，而不是只对超出部分加价', () => {
    const usage = {
      uncachedInputTokens: 300_000, cachedReadInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 1_000,
    };
    // 整单长档：300K * $0.40/M + 1K * $1.80/M
    expect(dollars(costMillicentsNormalized(usage)))
      .toBeCloseTo(0.3 * 0.40 + 0.001 * 1.80, 6);
  });
});

describe('sumNormalizedUsage', () => {
  it('多轮编排的用量逐项累加', () => {
    const total = sumNormalizedUsage([
      { uncachedInputTokens: 100, cachedReadInputTokens: 10, cacheWriteInputTokens: 1, outputTokens: 5 },
      { uncachedInputTokens: 200, cachedReadInputTokens: 20, cacheWriteInputTokens: 2, outputTokens: 7, reasoningTokens: 3 },
    ]);
    expect(total).toEqual({
      uncachedInputTokens: 300,
      cachedReadInputTokens: 30,
      cacheWriteInputTokens: 3,
      outputTokens: 12,
      reasoningTokens: 3,
    });
  });
});
