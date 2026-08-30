import { describe, expect, it } from 'vitest';
import {
  addDays, atWall, businessDateOf, calendarDateInZone, createQaClock, iso,
} from './clock';

describe('QA relative clock', () => {
  it('computes America/New_York business dates from a frozen instant', () => {
    const clock = createQaClock({
      timezone: 'America/New_York',
      now: '2026-08-30T16:00:00.000Z',
    });
    expect(calendarDateInZone(clock.now, clock.timezone)).toBe('2026-08-30');
    expect(businessDateOf(clock)).toBe('2026-08-30');
    expect(addDays(businessDateOf(clock), 1)).toBe('2026-08-31');
  });

  it('applies cutoff so a 03:00 NY instant is still yesterday', () => {
    const clock = createQaClock({
      timezone: 'America/New_York',
      cutoff: '04:00',
      now: '2026-08-30T07:30:00.000Z', // 03:30 EDT
    });
    expect(businessDateOf(clock)).toBe('2026-08-29');
  });

  it('does not use the machine-local timezone for wall conversion', () => {
    const clock = createQaClock({
      timezone: 'America/Los_Angeles',
      now: '2026-08-30T16:00:00.000Z',
    });
    const start = atWall(clock, '2026-08-30', '10:00');
    expect(iso(start)).toBe('2026-08-30T17:00:00.000Z');
  });
});
