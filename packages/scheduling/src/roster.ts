/**
 * 排班：周模板铺开与工时计算（03 §B Phase 1b）
 *
 * ⚠️ 班次存的是**墙上时间**（营业日 + 起止分钟），不是 timestamptz。
 *
 * 宪法第 8 条说「时间存 timestamptz」，那条针对的是**事件发生的时刻**
 * （预约几点开始、几点结账）。排班是**计划的墙上时间**：
 * 「Amy 每周二 10:00 到 19:00」在 DST 切换那天依然是 10:00 到 19:00，
 * 而不是凭空移动一小时。把班表烤成 timestamptz，春季那天全店班次会集体偏移，
 * 秋季那天则会出现两个 01:30 —— 这两种错都是要到发工资时才被发现的。
 *
 * 但**工时**必须按真实流逝时间算（那才是钱），所以有 shiftRealMinutes()：
 * 跨夜班遇上 DST 那天，8 小时的班实际只有 7 小时或 9 小时。
 *
 * 纯函数，无 IO。
 */

import { wallClock } from './business-day';

/** 0 = 周日，与 Date.getUTCDay() 对齐 */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface ShiftTemplateEntry {
  membershipId: string;
  weekday: Weekday;
  /** 当日 00:00 起的分钟数 */
  startMin: number;
  /**
   * 同上。**允许超过 1440 表示跨夜**：足疗店 18:00–次日 02:00 = 1080 → 1560。
   * 用「大于 1440」而不是「小于 startMin」来表达跨夜，是因为后者
   * 没法区分「录错了」和「真的跨夜」。
   */
  endMin: number;
  /** 无薪休息分钟（美国多数州 30 分钟餐休不计薪） */
  breakMin: number;
}

export interface PlannedShift {
  businessDate: string;      // YYYY-MM-DD
  membershipId: string;
  startMin: number;
  endMin: number;
  breakMin: number;
}

export function assertShiftBounds(startMin: number, endMin: number, breakMin: number): void {
  const ok = (v: number) => Number.isInteger(v) && v >= 0;
  if (!ok(startMin) || !ok(endMin) || !ok(breakMin)) {
    throw new Error('班次的起止与休息必须是非负整数分钟');
  }
  if (startMin >= 1440) throw new Error('班次开始时间必须落在当天（0–1439 分钟）');
  if (endMin <= startMin) throw new Error('班次结束必须晚于开始；跨夜请用大于 1440 的分钟数表示');
  if (endMin - startMin > 20 * 60) throw new Error('单个班次不能超过 20 小时');
  if (breakMin >= endMin - startMin) throw new Error('休息时间不能吃掉整个班次');
}

/** 日期加天数。用 UTC 做算术，避开本机时区 —— 与 business-day 同一套做法 */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y!, m! - 1, d! + days));
  return t.toISOString().slice(0, 10);
}

export function weekdayOf(date: string): Weekday {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay() as Weekday;
}

/**
 * 把周模板铺开成具体日期的班次。
 *
 * @param fromDate 起始营业日（含）
 * @param days     铺几天。前台按钮是「铺开一周」= 7，「铺开两周」= 14
 * @param skipDates 已经手工改过或放假的日期，不覆盖 ——
 *        一键铺开最怕的就是把前台昨天刚调好的班冲掉
 */
export function expandTemplate(args: {
  entries: readonly ShiftTemplateEntry[];
  fromDate: string;
  days: number;
  skipDates?: readonly string[];
}): PlannedShift[] {
  const { entries, fromDate, days } = args;
  if (!Number.isInteger(days) || days < 1 || days > 62) {
    throw new Error('一次最多铺开 62 天');
  }
  const skip = new Set(args.skipDates ?? []);
  const out: PlannedShift[] = [];

  for (let i = 0; i < days; i++) {
    const date = addDays(fromDate, i);
    if (skip.has(date)) continue;
    const dow = weekdayOf(date);
    for (const e of entries) {
      if (e.weekday !== dow) continue;
      assertShiftBounds(e.startMin, e.endMin, e.breakMin);
      out.push({
        businessDate: date,
        membershipId: e.membershipId,
        startMin: e.startMin,
        endMin: e.endMin,
        breakMin: e.breakMin,
      });
    }
  }
  return out;
}

/** 名义工时（墙上时间）。排班表上显示的就是这个 */
export function shiftNominalMinutes(s: Pick<PlannedShift, 'startMin' | 'endMin' | 'breakMin'>): number {
  return s.endMin - s.startMin - s.breakMin;
}

/**
 * 某个营业日的某个墙上分钟数，对应真实时间轴上的哪一刻。
 * minutes 允许 ≥ 1440（跨夜）。
 *
 * 迭代修正两次即可收敛，包括 DST 当天 —— 与 businessDayStart 同一套算法。
 * 春季那天 02:30 这个墙上时间不存在，结果会落到 03:30（等价时刻），
 * 这正是排班要的行为：那天没有 02:30 这一刻，班次自然顺延。
 */
export function wallMinuteToInstant(businessDate: string, timezone: string, minutes: number): Date {
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

/** Request/snapshot-local memoization, including date and timezone (DST safe).
 * Store timestamps, not mutable Dates; callers always get their own Date. */
export function createWallMinuteResolver(): typeof wallMinuteToInstant {
  const instants = new Map<string, number>();
  return (date, timezone, minutes) => {
    const key = `${date}|${timezone}|${minutes}`;
    let instant = instants.get(key);
    if (instant === undefined) {
      instant = wallMinuteToInstant(date, timezone, minutes).getTime();
      instants.set(key, instant);
    }
    return new Date(instant);
  };
}

/**
 * 实际工时（真实流逝分钟）—— 发工资用这个。
 *
 * DST 当天跨夜班会和名义工时差整整一小时。少算一小时技师会来问，
 * 多算一小时老板永远不会发现 —— 两种都不能接受。
 */
export function shiftRealMinutes(
  s: Pick<PlannedShift, 'businessDate' | 'startMin' | 'endMin' | 'breakMin'>,
  timezone: string,
): number {
  const start = wallMinuteToInstant(s.businessDate, timezone, s.startMin);
  const end = wallMinuteToInstant(s.businessDate, timezone, s.endMin);
  return Math.round((end.getTime() - start.getTime()) / 60_000) - s.breakMin;
}

/** 按人汇总一段时间的工时。报表和保底工资都吃这个 */
export function totalMinutesByStaff(
  shifts: readonly PlannedShift[],
  timezone: string,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of shifts) {
    out.set(s.membershipId, (out.get(s.membershipId) ?? 0) + shiftRealMinutes(s, timezone));
  }
  return out;
}

/** 'HH:MM' ↔ 分钟。前台输入框用 */
export function minutesToHHMM(min: number): string {
  const m = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

export function hhmmToMinutes(v: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (!m) throw new Error(`时间格式应为 HH:MM，收到：${v}`);
  return Number(m[1]) * 60 + Number(m[2]);
}
