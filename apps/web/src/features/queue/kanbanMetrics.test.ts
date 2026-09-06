import { describe, expect, it } from 'vitest';
import { settledRevenueCents } from './kanbanMetrics';

describe('settledRevenueCents', () => {
  it('日结有数时，营收 = 净额 + 现金小费 + 刷卡小费', () => {
    expect(settledRevenueCents({
      netCents: 4500,
      tipCashCents: 0,
      tipCardCents: 675,
      fallbackServiceCents: 4500,
    })).toBe(5175);
  });

  it('没有日结快照时退回已结服务价，不编造小费', () => {
    expect(settledRevenueCents({
      fallbackServiceCents: 4500,
    })).toBe(4500);
  });
});
