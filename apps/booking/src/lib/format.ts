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
