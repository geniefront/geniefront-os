/**
 * Deterministic relative time for Seed V2.
 *
 * Business dates are computed in an explicit IANA timezone, never the
 * machine-local zone. Override the clock with QA_NOW (ISO-8601) so two
 * reset+seed runs compare equal even if wall time moved.
 */

export const DEFAULT_QA_TIMEZONE = 'America/New_York';
export const SECOND_QA_TIMEZONE = 'America/Los_Angeles';
export const DEFAULT_CUTOFF = '04:00';

export type QaClock = {
  now: Date;
  timezone: string;
  cutoff: string;
};

function wallClock(instant: Date, timezone: string): {
  year: number; month: number; day: number; hour: number; minute: number;
} {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(instant);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return {
    year: get('year'), month: get('month'), day: get('day'),
    hour: get('hour'), minute: get('minute'),
  };
}

/** Resolve the controlled clock. Unset QA_NOW → Date.now(). */
export function resolveQaNow(override?: string | Date | null): Date {
  if (override instanceof Date) return override;
  if (typeof override === 'string' && override.trim()) {
    const parsed = new Date(override);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error(`QA_NOW is not a valid ISO timestamp: ${override}`);
    }
    return parsed;
  }
  const fromEnv = process.env['QA_NOW'];
  if (fromEnv) {
    const parsed = new Date(fromEnv);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error(`QA_NOW is not a valid ISO timestamp: ${fromEnv}`);
    }
    return parsed;
  }
  return new Date();
}

export function createQaClock(args: {
  timezone?: string;
  cutoff?: string;
  now?: string | Date | null;
} = {}): QaClock {
  return {
    now: resolveQaNow(args.now),
    timezone: args.timezone ?? DEFAULT_QA_TIMEZONE,
    cutoff: args.cutoff ?? DEFAULT_CUTOFF,
  };
}

export function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function isoDateUtc(d: Date): string {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** Shop-local calendar date (YYYY-MM-DD), ignoring cutoff. */
export function calendarDateInZone(instant: Date, timezone: string): string {
  const w = wallClock(instant, timezone);
  return `${w.year}-${pad2(w.month)}-${pad2(w.day)}`;
}

/** Shop business date, applying business_day_cutoff. */
export function businessDateOf(clock: QaClock, instant = clock.now): string {
  const m = /^(\d{2}):(\d{2})/.exec(clock.cutoff);
  if (!m) throw new Error(`business_day_cutoff must be HH:MM, got ${clock.cutoff}`);
  const cutoffMinutes = Number(m[1]) * 60 + Number(m[2]);
  const w = wallClock(instant, clock.timezone);
  const minutes = w.hour * 60 + w.minute;
  const d = new Date(Date.UTC(w.year, w.month - 1, w.day));
  if (minutes < cutoffMinutes) d.setUTCDate(d.getUTCDate() - 1);
  return isoDateUtc(d);
}

export function addDays(date: string, days: number): string {
  const [y, mo, d] = date.split('-').map(Number);
  const next = new Date(Date.UTC(y!, mo! - 1, d! + days));
  return isoDateUtc(next);
}

/**
 * Convert a shop-local wall time on a business date to an instant.
 * Same iterative offset correction as packages/scheduling wallMinuteToInstant.
 */
export function wallMinuteToInstant(
  businessDate: string,
  timezone: string,
  minutes: number,
): Date {
  const [y, mo, d] = businessDate.split('-').map(Number);
  const dayOffset = Math.floor(minutes / 1440);
  const rest = minutes - dayOffset * 1440;
  const hh = Math.floor(rest / 60);
  const mm = rest % 60;
  const want = Date.UTC(y!, mo! - 1, d! + dayOffset, hh, mm);
  let guess = want;
  for (let i = 0; i < 2; i++) {
    const w = wallClock(new Date(guess), timezone);
    const actual = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
    guess += want - actual;
  }
  return new Date(guess);
}

export function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h! * 60 + m!;
}

export function atWall(clock: QaClock, date: string, hhmm: string): Date {
  return wallMinuteToInstant(date, clock.timezone, hhmmToMinutes(hhmm));
}

export function iso(d: Date): string {
  return d.toISOString();
}

export function futureTrialEnd(clock: QaClock, trialDays: number): Date {
  return new Date(clock.now.getTime() + trialDays * 86_400_000);
}

export function periodEnd(clock: QaClock, days = 30): Date {
  return new Date(clock.now.getTime() + days * 86_400_000);
}
