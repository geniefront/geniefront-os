import { describe, expect, it } from 'vitest';
import { businessDateOf } from './business-day';
import {
  bookableDateCount, isBookableDate, lastBookableDate,
} from './booking-window';

describe('inclusive booking horizon', () => {
  it('allows today and today+maxDaysAhead, rejects the next day', () => {
    expect(bookableDateCount(60)).toBe(61);
    expect(lastBookableDate('2026-09-01', 60)).toBe('2026-10-31');
    expect(isBookableDate('2026-09-01', '2026-09-01', 60)).toBe(true);
    expect(isBookableDate('2026-10-31', '2026-09-01', 60)).toBe(true);
    expect(isBookableDate('2026-11-01', '2026-09-01', 60)).toBe(false);
    expect(isBookableDate('2026-08-31', '2026-09-01', 60)).toBe(false);
  });

  it('uses the business date when the wall clock is before cutoff', () => {
    // 02:00 America/New_York on 2 Sep 2026 (EDT = UTC-4 → 06:00Z)
    const instant = new Date('2026-09-02T06:00:00.000Z');
    const today = businessDateOf(instant, 'America/New_York', '03:00');
    expect(today).toBe('2026-09-01');
    expect(lastBookableDate(today, 2)).toBe('2026-09-03');
    expect(isBookableDate('2026-09-03', today, 2)).toBe(true);
    expect(isBookableDate('2026-09-04', today, 2)).toBe(false);
    // Wall-clock 2 Sep + 2 days would be 4 Sep, which is outside the business horizon.
    expect(isBookableDate('2026-09-04', '2026-09-02', 2)).toBe(true);
  });
});
