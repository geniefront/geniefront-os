import { describe, it, expect } from 'vitest';
import {
  costMillicents, millicentsToCents, billableTokens, sumUsage, OPUS_5_RATES,
} from './cost';

describe('用量计价', () => {
  it('对得上 05 §5.1 里那个 $0.024/张 的量级', () => {
    // 单图约 4784 视觉 token + 系统提示，输出几百 token
    const m = costMillicents({ inputTokens: 6000, outputTokens: 800 });
    // 6000 × $5/M + 800 × $25/M = $0.030 + $0.020 = $0.050 = 5 分 = 5000 毫分
    expect(m).toBe(5000);
    expect(millicentsToCents(m)).toBe(5);
  });

  it('缓存命中按 0.1 倍算 —— 第二张图开始的系统提示是这个价', () => {
    const cold = costMillicents({ inputTokens: 3000, outputTokens: 0 });
    const warm = costMillicents({
      inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 3000,
    });
    expect(warm * 10).toBe(cold);
  });

  it('全程整数，不出现浮点残渣', () => {
    // 1 个 token 是 0.5 毫分，向上取整成 1 —— 少收自己的钱比多收好
    expect(costMillicents({ inputTokens: 1, outputTokens: 0 })).toBe(1);
    expect(Number.isInteger(costMillicents({ inputTokens: 7, outputTokens: 3 }))).toBe(true);
  });

  it('qty 记的是总 token，缓存读写也算进去', () => {
    expect(billableTokens({
      inputTokens: 100, outputTokens: 50,
      cacheReadInputTokens: 3000, cacheCreationInputTokens: 20,
    })).toBe(3170);
  });

  it('多张图的用量能合计', () => {
    const total = sumUsage([
      { inputTokens: 6000, outputTokens: 500, cacheCreationInputTokens: 2000 },
      { inputTokens: 5800, outputTokens: 400, cacheReadInputTokens: 2000 },
    ]);
    expect(total).toEqual({
      inputTokens: 11800, outputTokens: 900,
      cacheReadInputTokens: 2000, cacheCreationInputTokens: 2000,
    });
  });

  it('Opus 5 的费率就是 05 §7 那张表', () => {
    expect(OPUS_5_RATES.inputPerMTok).toBe(500_000);    // $5.00/M
    expect(OPUS_5_RATES.outputPerMTok).toBe(2_500_000); // $25.00/M
  });
});
