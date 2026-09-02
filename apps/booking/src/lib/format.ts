/**
 * Display formatting. Every time formatter takes the shop IANA timezone.
 * Browser timezone is never used for appointment times.
 */

export function timeOf(iso: string, timezone: string, locale = 'en-US'): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: timezone, hour: 'numeric', minute: '2-digit',
  }).format(new Date(iso));
}

export function dateOf(iso: string, timezone: string, locale = 'en-US'): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: timezone, weekday: 'long', month: 'long', day: 'numeric',
  }).format(new Date(iso));
}

export function dayParts(date: string, locale = 'en-US'): { weekday: string; day: string } {
  const d = new Date(`${date}T12:00:00Z`);
  return {
    weekday: new Intl.DateTimeFormat(locale, { timeZone: 'UTC', weekday: 'short' }).format(d),
    day: new Intl.DateTimeFormat(locale, { timeZone: 'UTC', day: 'numeric' }).format(d),
  };
}

export const money = (cents: number, currency = 'USD'): string =>
  new Intl.NumberFormat('en-US', {
    style: 'currency', currency, minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);

export const duration = (min: number): string =>
  min >= 60 ? `${Math.floor(min / 60)}h${min % 60 ? ` ${min % 60}m` : ''}` : `${min} min`;

export function todayIn(timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

import {
  addCalendarDays, bookableDateCount, businessDateOf,
} from '@gf/scheduling';

export {
  bookableDateCount, isBookableDate, lastBookableDate,
} from '@gf/scheduling';

export function addDays(date: string, days: number): string {
  return addCalendarDays(date, days);
}

/** Visible day-strip page size. The search horizon is shop.maxDaysAhead (inclusive). */
export const DAY_PAGE = 14;

export function diffDays(from: string, to: string): number {
  const a = new Date(`${from}T12:00:00Z`).getTime();
  const b = new Date(`${to}T12:00:00Z`).getTime();
  return Math.round((b - a) / 86_400_000);
}

export function bookingToday(timezone: string, cutoff?: string | null): string {
  if (cutoff && /^\d{2}:\d{2}/.test(cutoff)) {
    return businessDateOf(new Date(), timezone, cutoff);
  }
  return todayIn(timezone);
}

/**
 * Page the inclusive window today .. today+maxDaysAhead.
 * `maxDaysAhead` is the last offset, not the date count.
 */
export function datePage(start: string, maxDaysAhead: number, offset: number): string[] {
  const total = bookableDateCount(maxDaysAhead);
  const page = Math.min(DAY_PAGE, total);
  const maxOffset = Math.max(0, total - page);
  const o = Math.min(Math.max(0, offset), maxOffset);
  return Array.from({ length: page }, (_, i) => addDays(start, o + i));
}

export function pageOffsetForDate(start: string, maxDaysAhead: number, date: string): number {
  const total = bookableDateCount(maxDaysAhead);
  const page = Math.min(DAY_PAGE, total);
  const maxOffset = Math.max(0, total - page);
  const selected = Math.max(0, diffDays(start, date));
  const aligned = Math.floor(selected / page) * page;
  return Math.min(aligned, maxOffset);
}

export function toE164(raw: string): string | null {
  const d = raw.replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  if (raw.trim().startsWith('+') && d.length >= 8 && d.length <= 15) return `+${d}`;
  return null;
}

export function prettyPhone(raw: string): string {
  const d = raw.replace(/\D/g, '').slice(0, 10);
  if (d.length <= 3) return d;
  if (d.length <= 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}
