import { prettyPhone, toE164 } from './format';
import { describe, expect, it } from 'vitest';
import { addDays, bookableDateCount, datePage, DAY_PAGE, lastBookableDate, pageOffsetForDate } from './format';

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

  it('includes today+maxDaysAhead as the last bookable date', () => {
    const start = '2026-09-01';
    expect(bookableDateCount(60)).toBe(61);
    expect(lastBookableDate(start, 60)).toBe('2026-10-31');
    const lastPage = datePage(start, 60, pageOffsetForDate(start, 60, lastBookableDate(start, 60)));
    expect(lastPage.at(-1)).toBe('2026-10-31');
  });
});

it('preserves international booking phone numbers and defaults local numbers to +1', () => {
  expect(prettyPhone('+44 7911 123456')).toBe('+44 7911 123456');
  expect(toE164('+44 7911 123456')).toBe('+447911123456');
  expect(toE164('6676606667')).toBe('+16676606667');
  expect(toE164('abc6676606667')).toBeNull();
});
