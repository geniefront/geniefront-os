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

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Visible day-strip page size. The search horizon is shop.maxDaysAhead. */
export const DAY_PAGE = 14;

export function diffDays(from: string, to: string): number {
  const a = new Date(`${from}T12:00:00Z`).getTime();
  const b = new Date(`${to}T12:00:00Z`).getTime();
  return Math.round((b - a) / 86_400_000);
}

export function datePage(start: string, horizon: number, offset: number): string[] {
  const h = Math.max(1, Math.floor(horizon));
  const page = Math.min(DAY_PAGE, h);
  const maxOffset = Math.max(0, h - page);
  const o = Math.min(Math.max(0, offset), maxOffset);
  return Array.from({ length: page }, (_, i) => addDays(start, o + i));
}

export function pageOffsetForDate(start: string, horizon: number, date: string): number {
  const h = Math.max(1, Math.floor(horizon));
  const page = Math.min(DAY_PAGE, h);
  const maxOffset = Math.max(0, h - page);
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
