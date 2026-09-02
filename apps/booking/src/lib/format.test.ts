import { describe, expect, it } from 'vitest';
import { addDays, datePage, DAY_PAGE, pageOffsetForDate } from './format';

describe('datePage', () => {
  it('pages a horizon larger than 14 days instead of capping search at 14', () => {
    const start = '2026-09-01';
    expect(datePage(start, 60, 0)).toEqual(
      Array.from({ length: DAY_PAGE }, (_, i) => addDays(start, i)),
    );
    expect(datePage(start, 60, 14)[0]).toBe('2026-09-15');
    expect(datePage(start, 60, 14)).toHaveLength(14);
    expect(pageOffsetForDate(start, 60, '2026-09-21')).toBe(14);
    expect(addDays(start, 20)).toBe('2026-09-21');
  });
});
