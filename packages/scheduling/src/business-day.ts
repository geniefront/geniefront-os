/**
 * 营业日边界（宪法第 8 条）
 *
 * 足疗/按摩店开到凌晨 2:00 是常态。凌晨 1:30 开的单必须归入「昨天」的营业日，
 * 否则打烊日结和现金小费发放会被切成两天 —— 那是每天最容易吵架的环节。
 *
 * 时间一律 timestamptz 存储，但营业日必须按门店的**墙上时间**算。
 * 纯函数，无 IO，不依赖运行环境的时区。
 */

/** 把一个时刻转成指定时区的墙上时间分量 */
export function wallClock(instant: Date, timezone: string): {
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

/**
 * 这个时刻属于哪个营业日。
 *
 * @param cutoff 'HH:MM'，门店的 business_day_cutoff。
 *               早于它的时刻归前一天。美甲店常设 21:00 之类的其实用不上，
 *               足疗店设 03:00 —— 凌晨 2:30 的单还算昨天。
 * @returns 'YYYY-MM-DD'（门店本地日期）
 */
export function businessDateOf(instant: Date, timezone: string, cutoff: string): string {
  const m = /^(\d{2}):(\d{2})/.exec(cutoff);
  if (!m) throw new Error(`business_day_cutoff 格式应为 HH:MM，收到：${cutoff}`);
  const cutoffMinutes = Number(m[1]) * 60 + Number(m[2]);

  const w = wallClock(instant, timezone);
  const minutes = w.hour * 60 + w.minute;

  // 用 UTC 日期做算术，避开本机时区的干扰
  const d = new Date(Date.UTC(w.year, w.month - 1, w.day));
  if (minutes < cutoffMinutes) d.setUTCDate(d.getUTCDate() - 1);

  return d.toISOString().slice(0, 10);
}

/**
 * DST 那两天必须有测试（宪法第 8 条）。
 * 美国春季 3 月第二个周日 02:00 跳到 03:00 —— 那天只有 23 小时，
 * 02:00–03:00 这一小时在本地时间里根本不存在。
 * 秋季 11 月第一个周日 02:00 退回 01:00 —— 01:00–02:00 出现两次。
 *
 * 这个函数返回该营业日在门店时区里实际有多少分钟，
 * 排班工时统计要用它，否则 DST 当天会多算或少算一小时。
 */
export function businessDayMinutes(
  businessDate: string, timezone: string, cutoff: string,
): number {
  const start = businessDayStart(businessDate, timezone, cutoff);
  const [y, mo, d] = businessDate.split('-').map(Number);
  const next = new Date(Date.UTC(y!, mo! - 1, d! + 1));
  const nextDate = next.toISOString().slice(0, 10);
  const end = businessDayStart(nextDate, timezone, cutoff);
  return Math.round((end.getTime() - start.getTime()) / 60000);
}

/** 某个营业日在真实时间轴上的起点 */
export function businessDayStart(businessDate: string, timezone: string, cutoff: string): Date {
  const m = /^(\d{2}):(\d{2})/.exec(cutoff);
  if (!m) throw new Error(`business_day_cutoff 格式应为 HH:MM，收到：${cutoff}`);
  const [y, mo, d] = businessDate.split('-').map(Number);

  // 先猜一个 UTC 时刻，再根据该时区的实际偏移修正。
  // 迭代两次足以收敛，包括 DST 切换当天。
  let guess = Date.UTC(y!, mo! - 1, d!, Number(m[1]), Number(m[2]));
  for (let i = 0; i < 2; i++) {
    const w = wallClock(new Date(guess), timezone);
    const actual = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
    const want = Date.UTC(y!, mo! - 1, d!, Number(m[1]), Number(m[2]));
    guess += want - actual;
  }
  return new Date(guess);
}
