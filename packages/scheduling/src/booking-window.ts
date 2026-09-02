/**
 * Inclusive online-booking horizon.
 *
 * `maxDaysAhead` is the offset of the last bookable **business date**
 * from today, not the number of dates in the window. Today and
 * `today + maxDaysAhead` are both allowed.
 *
 * That matches GET /public/v1/availability:
 *   reject when date < today or date > addDays(today, maxDaysAhead)
 *
 * "Today" is the shop's current business date (`businessDateOf`), not
 * the wall-clock calendar date. A 02:00 request with cutoff 03:00 still
 * belongs to yesterday's horizon.
 */

export function addCalendarDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function lastBookableDate(today: string, maxDaysAhead: number): string {
  const n = Math.max(0, Math.floor(maxDaysAhead));
  return addCalendarDays(today, n);
}

/** Inclusive count: today through today+maxDaysAhead. */
export function bookableDateCount(maxDaysAhead: number): number {
  return Math.max(0, Math.floor(maxDaysAhead)) + 1;
}

export function isBookableDate(
  date: string, today: string, maxDaysAhead: number,
): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  return date >= today && date <= lastBookableDate(today, maxDaysAhead);
}
