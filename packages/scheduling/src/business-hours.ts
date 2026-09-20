/**
 * 营业时间闸门 —— 「九点开门，客人要约八点」那件事
 *
 * ## 为什么这个文件到现在才出现
 *
 * `ERROR_CODES.OUTSIDE_BUSINESS_HOURS` 从第一天就在错误码表里、在
 * `OVERRIDABLE_CODES` 里、在前台两份 i18n 里 —— **但从来没有人抛过它**。
 * 也就是说建单这条路上根本没有营业时间这一层：前台想约凌晨三点就能约成。
 *
 * 这个文件补上那一层，并且把它做成**老板可调**的：
 *
 *   · 门店开 09:30，`before_open_minutes = 60` → 08:30 起就能约，不报错
 *   · 超出这个窗口 → 抛 `OUTSIDE_BUSINESS_HOURS`，前台带 reason 可以放行
 *   · 老板把 `beyond` 设成 `block` → 连 reason 都不给，一律不许
 *
 * ## 三条刻意的取舍
 *
 * **① 找空档的那条路不吃这个宽限。** `findOpenSlots` 仍然只在
 * [open, close] 里找。宽限窗口是「前台手工能录进去」，不是
 * 「官网和电话 AI 会主动报出来」—— 报出来客人就会订，而那个点
 * 店里一个人都没有。老板要的是「客人问了我可以答应」，不是「挂出去卖」。
 *
 * **② `business_hours` 一个键都没有 = 还没配，不是不营业。**
 * 新店从 Stripe 建出来时 `business_hours` 是 `'{}'`，开店向导填完才有值。
 * 把空对象当成「七天全关」，新店第一单就会被自己的闸门挡住。
 *
 * **③ 那一天没有营业时间 = 关门，宽限不适用。** 周日不开门的店，
 * 「关门前后一小时」没有可以围绕的锚点。周日的单一律走 `CLOSED_DAY`，
 * 由前台带 reason 放行（老板为熟客特意开门是真实存在的事）。
 *
 * 纯函数，无 IO。
 */

import { wallClock } from './business-day';

export const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type WeekdayKey = (typeof WEEKDAY_KEYS)[number];

export interface DayHours { open: string; close: string; periods?: Array<{open:string;close:string}> }
export type WeeklyHours = Partial<Record<WeekdayKey, DayHours | null>>;

/** 老板在后台设的那两个数字（`locations.settings.off_hours`） */
export interface OffHoursWindow {
  /** 开门前多久仍然算「可以约」。0 = 一分钟都不提前 */
  beforeOpenMinutes: number;
  /** 关门后多久 */
  afterCloseMinutes: number;
}

export const NO_OFF_HOURS: OffHoursWindow = { beforeOpenMinutes: 0, afterCloseMinutes: 0 };

/** 某个营业日的时间边界，单位是**营业日墙上分钟**（跨午夜可以 ≥ 1440） */
export interface DayWindow {
  openMin: number;
  closeMin: number;
  /** 含宽限之后，最早允许的起点 */
  earliestMin: number;
  /** 含宽限之后，最晚允许的终点 */
  latestMin: number;
}

export interface BusinessHoursIssue {
  code: 'CLOSED_DAY' | 'BEFORE_OPEN' | 'AFTER_CLOSE' | 'BREAK';
  businessDate: string;
  /** 关门那天是 null */
  window: DayWindow | null;
  /** 这一单实际落在营业日的哪一段（墙上分钟） */
  startMin: number;
  endMin: number;
}

/** `business_hours` 里一个键都没有 = 开店向导还没走到那一步 */
export function hoursConfigured(hours: WeeklyHours | null | undefined): boolean {
  return !!hours && Object.keys(hours).length > 0;
}

/**
 * `'YYYY-MM-DD'` 是星期几，返回 `business_hours` 用的那个键。
 *
 * ⚠️ 和 roster.ts 的 `weekdayOf` 是两个东西：那个返回数字 0–6（排班模板用），
 * 这个返回 `'mon'`。名字必须不一样，否则 index.ts 的 `export *` 会撞。
 * 用 UTC 正午取，避开本机时区把日期挪走一天。
 */
export function weekdayKeyOf(businessDate: string): WeekdayKey {
  return WEEKDAY_KEYS[new Date(`${businessDate}T12:00:00Z`).getUTCDay()]!;
}

/**
 * 某个时刻落在这个营业日的第几分钟。
 *
 * ⚠️ 用**墙上时间**算，不是 `(instant - dayStart) / 60000`。
 * DST 那天真实流逝分钟和墙上分钟差整整一小时，用后者会把
 * 秋令时那天 14:00 的单算成 13:00，然后和 close 比出错误的结论。
 */
export function wallMinutesOf(businessDate: string, timezone: string, instant: Date): number {
  const w = wallClock(instant, timezone);
  const [y, mo, d] = businessDate.split('-').map(Number);
  const dayDiff = Math.round(
    (Date.UTC(w.year, w.month - 1, w.day) - Date.UTC(y!, mo! - 1, d!)) / 86_400_000,
  );
  return dayDiff * 1440 + w.hour * 60 + w.minute;
}

const hhmm = (v: string): number => {
  const m = /^(\d{1,2}):(\d{2})/.exec(v.trim());
  if (!m) throw new Error(`营业时间格式应为 HH:MM，收到：${v}`);
  return Number(m[1]) * 60 + Number(m[2]);
};

/**
 * 这一天的可约窗口。`null` = 那天不营业。
 *
 * 跨午夜（足疗店开到凌晨 1:00）时 close 加一天 —— 和 `queries/slots.ts`
 * 里的口径逐字一致，否则「找空档说有、建单说超了」。
 */
export function dayWindow(
  businessDate: string,
  hours: WeeklyHours | null | undefined,
  window: OffHoursWindow = NO_OFF_HOURS,
): DayWindow | null {
  const windows = dayWindows(businessDate, hours, window);
  if (!windows.length) return null;
  return {...windows[0]!, closeMin:windows.at(-1)!.closeMin, latestMin:windows.at(-1)!.latestMin};
}

/**
 * 这一单能不能放进这一天。
 *
 * 返回 `null` = 放行。返回 issue = 越界了，**由调用方决定怎么处置**
 * （前台可带 reason 放行、官网和电话 AI 一律不许）—— 纯函数不认识渠道。
 */
export function checkBusinessHours(args: {
  businessDate: string;
  timezone: string;
  startsAt: Date;
  endsAt: Date;
  hours: WeeklyHours | null | undefined;
  window?: OffHoursWindow;
}): BusinessHoursIssue | null {
  const { businessDate, timezone, startsAt, endsAt, hours } = args;

  // 还没配营业时间的新店不设闸门（见文件头 ②）
  if (!hoursConfigured(hours)) return null;

  const startMin = wallMinutesOf(businessDate, timezone, startsAt);
  const endMin = wallMinutesOf(businessDate, timezone, endsAt);
  const win = dayWindow(businessDate, hours, args.window ?? NO_OFF_HOURS);

  if (!win) return { code: 'CLOSED_DAY', businessDate, window: null, startMin, endMin };
  if (startMin < win.earliestMin) {
    return { code: 'BEFORE_OPEN', businessDate, window: win, startMin, endMin };
  }
  if (endMin > win.latestMin) {
    return { code: 'AFTER_CLOSE', businessDate, window: win, startMin, endMin };
  }
  if (!dayWindows(businessDate, hours, args.window ?? NO_OFF_HOURS).some(w=>startMin>=w.earliestMin && endMin<=w.latestMin)) {
    return {code:'BREAK',businessDate,window:win,startMin,endMin};
  }
  return null;
}

/** Explicit periods are authoritative. Null means closed; legacy objects remain readable. */
export function hourPeriods(day: DayHours | null | undefined): Array<{open:string;close:string}> {
 return day ? day.periods ?? [{open:day.open,close:day.close}] : [];
}
/** Never offer times in gaps. Outer before/after grace does not extend lunch breaks. */
export function dayWindows(date:string,hours:WeeklyHours|null|undefined,grace:OffHoursWindow=NO_OFF_HOURS):DayWindow[] {
 const periods=hourPeriods(hours?.[weekdayKeyOf(date)]).map(p=>{
 const openMin=hhmm(p.open),end=hhmm(p.close);
 return {openMin,closeMin:end<=openMin?end+1440:end,earliestMin:openMin,latestMin:end<=openMin?end+1440:end};
 }).sort((a,b)=>a.openMin-b.openMin).reduce<DayWindow[]>((out,w)=>{const last=out.at(-1);if(last && w.openMin<=last.closeMin){last.closeMin=Math.max(last.closeMin,w.closeMin);last.latestMin=last.closeMin;}else out.push(w);return out;},[]);
 if(periods.length){periods[0]!.earliestMin-=Math.max(0,grace.beforeOpenMinutes);periods.at(-1)!.latestMin+=Math.max(0,grace.afterCloseMinutes);}
 return periods;
}
