import { describe, it, expect } from 'vitest';
import {
  normalizeOpenAiUsage,
  costMillicentsNormalized,
  sumNormalizedUsage,
  billableTokensNormalized,
} from './usage.js';
import { LUNA_RATES } from './config.js';

describe('NormalizedUsage Adapter (29 §12.1)', () => {
  it('correctly separates uncached and cached tokens from OpenAI prompt_tokens', () => {
    // In OpenAI, prompt_tokens includes cached_tokens
    const raw = {
      prompt_tokens: 4500,
      completion_tokens: 500,
      total_tokens: 5000,
      prompt_tokens_details: {
        cached_tokens: 3500,
      },
      completion_tokens_details: {
        reasoning_tokens: 150,
      },
    };

    const normalized = normalizeOpenAiUsage(raw);
    expect(normalized.uncachedInputTokens).toBe(1000); // 4500 - 3500
    expect(normalized.cachedReadInputTokens).toBe(3500);
    expect(normalized.outputTokens).toBe(500);
    expect(normalized.reasoningTokens).toBe(150);
  });

  it('handles empty or undefined usage gracefully', () => {
    const normalized = normalizeOpenAiUsage(undefined);
    expect(normalized.uncachedInputTokens).toBe(0);
    expect(normalized.cachedReadInputTokens).toBe(0);
    expect(normalized.outputTokens).toBe(0);
  });

  it('computes integer millicents cost with ceiling', () => {
    const usage = {
      uncachedInputTokens: 1000,
      cachedReadInputTokens: 4000,
      outputTokens: 500,
    };

    // inputPerMTok: 300_000, outputPerMTok: 1_500_000, cacheReadPerMTok: 30_000
    // parts = 1000 * 300_000 + 500 * 1_500_000 + 4000 * 30_000
    //       = 300_000_000 + 750_000_000 + 120_000_000 = 1_170_000_000
    // cost = ceil(1_170_000_000 / 1_000_000) = 1170 millicents ($0.0117)
    const cost = costMillicentsNormalized(usage, LUNA_RATES);
    expect(cost).toBe(1170);
  });

  it('sums multiple usages accurately including reasoning tokens', () => {
    const u1 = {
      uncachedInputTokens: 500,
      cachedReadInputTokens: 1000,
      outputTokens: 200,
      reasoningTokens: 50,
    };
    const u2 = {
      uncachedInputTokens: 300,
      cachedReadInputTokens: 2000,
      outputTokens: 400,
      reasoningTokens: 100,
    };

    const sum = sumNormalizedUsage([u1, u2]);
    expect(sum.uncachedInputTokens).toBe(800);
    expect(sum.cachedReadInputTokens).toBe(3000);
    expect(sum.outputTokens).toBe(600);
    expect(sum.reasoningTokens).toBe(150);
    expect(billableTokensNormalized(sum)).toBe(4400);
  });
});
