import { describe, expect, it } from 'vitest';
import { displayedCashVarianceCents, hasSavedCashCount } from './cashCount';

describe('hasSavedCashCount', () => {
  it('没点钞保存过就不能封账', () => {
    expect(hasSavedCashCount(null)).toBe(false);
    expect(hasSavedCashCount(undefined)).toBe(false);
  });

  it('保存过 0 也算点过钞', () => {
    expect(hasSavedCashCount(0)).toBe(true);
  });
});

describe('displayedCashVarianceCents', () => {
  it('还没点钞时概览不把账面负现金当成「长款」', () => {
    expect(displayedCashVarianceCents({
      countedCashCents: null,
      liveCountedCents: 0,
      expectedCashCents: -500,
    })).toBeNull();
  });

  it('点过钞才显示实点减账面', () => {
    expect(displayedCashVarianceCents({
      countedCashCents: 0,
      liveCountedCents: 0,
      expectedCashCents: -500,
    })).toBe(500);
  });
});
