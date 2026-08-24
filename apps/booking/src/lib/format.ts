/**
 * 显示层的格式化。
 *
 * ## ⭐ 时间一律按**门店时区**，不是客人浏览器的时区
 *
 * 这是这一页最容易错、而且错得最安静的地方：一个在加州刷到波士顿这家店的
 * 客人，用 `toLocaleTimeString()` 会看到全部时间差三小时 —— 他照着订，
 * 然后早三小时到店。本地开发永远测不出来，因为你的电脑和店在同一个时区。
 *
 * 所以这个文件里每一个 Intl 都显式传 `timeZone`，一个都不许漏。
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

/** 日期条上那两行：星期几 + 几号 */
export function dayParts(date: string, timezone: string, locale = 'en-US'):
  { weekday: string; day: string } {
  // 正午作锚点：cutoff 最晚也就凌晨几点，正午永远落在这一天
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

/** 门店当地的今天。`YYYY-MM-DD` */
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

/**
 * 手机号规范化成 E.164。
 *
 * ⚠️ **官网这边先挡一道**（docs/13 §4.4）：号码错了确认短信发不出去，
 * 而客人以为约上了。规范不出来就当场让他重输，别把一个半成品交上去。
 *
 * 只处理北美 —— 这个系统现在只服务美国门店（`00-DISCOVERY`）。
 * 有别的国家再说，猜着写反而会把好号码判错。
 */
export function toE164(raw: string): string | null {
  const d = raw.replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  if (raw.trim().startsWith('+') && d.length >= 8 && d.length <= 15) return `+${d}`;
  return null;
}

/** 输入时的友好显示：(617) 555-0199 */
export function prettyPhone(raw: string): string {
  const d = raw.replace(/\D/g, '').slice(0, 10);
  if (d.length <= 3) return d;
  if (d.length <= 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}
