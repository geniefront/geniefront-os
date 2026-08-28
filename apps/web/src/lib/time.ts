/**
 * 门店时区下的时间换算。
 *
 * ⚠️ **一律不得使用浏览器本地时区。** 连锁门店可能跨时区，出差中的老板浏览器
 * 时区与门店不符 —— 用本地时区计算营业日会把凌晨的单归到错误的日期，
 * 直接影响日结与提成。所有换算都必须显式传入门店时区（来源：
 * `GET /v1/me/context` 或 `GET /v1/desk/day` 返回的 `timezone`）。
 *
 * 营业日边界的实现复用 `@gf/scheduling`，与服务端同一份代码 ——
 * 前后端各写一份的结果必然是在 DST 那两天分叉。
 */
import { wallClock } from '@gf/scheduling';

/** 一天的分钟总数。日历网格以门店墙上时间的分钟数为坐标。 */
export const MINUTES_PER_DAY = 24 * 60;

/**
 * 把一个时刻转换为门店墙上时间的「当日第几分钟」。
 *
 * ⚠️ 返回值可能超出 [0, 1440)：营业到次日凌晨的门店，其营业日的结束时刻
 * 落在下一个自然日。调用方需按 `businessDate` 判断该时刻是否跨日，
 * 跨日时应加上 MINUTES_PER_DAY 后再定位到网格。
 */
export function instantToWallMinutes(iso: string, timezone: string): number {
  const w = wallClock(new Date(iso), timezone);
  return w.hour * 60 + w.minute;
}

/** 门店墙上时间的日期分量，格式 `YYYY-MM-DD`。 */
export function instantToWallDate(iso: string, timezone: string): string {
  const w = wallClock(new Date(iso), timezone);
  return `${w.year}-${String(w.month).padStart(2, '0')}-${String(w.day).padStart(2, '0')}`;
}

/**
 * 把「某营业日的第几分钟」还原为带偏移量的 ISO 时刻，用于命令入参。
 *
 * ⚠️ 实现方式为二分逼近而非直接构造：`new Date(y, m, d, h, min)` 使用的是
 * 浏览器本地时区，无法直接构造出「门店时区的某个墙上时间」。而 DST 切换日
 * 存在不存在的时刻（春季跳过的一小时）与重复的时刻（秋季重复的一小时），
 * 任何基于固定偏移量的算法在这两天都会算错。
 *
 * 逼近的收敛条件是「转换回墙上时间后与目标一致」，因此在 DST 边界上
 * 得到的是一个真实存在且唯一确定的时刻。
 */
export function wallMinutesToInstant(
  businessDate: string,
  minutes: number,
  timezone: string,
): string {
  const dayOffset = Math.floor(minutes / MINUTES_PER_DAY);
  const minuteOfDay = ((minutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;

  const [y, m, d] = businessDate.split('-').map(Number);
  const targetDate = new Date(Date.UTC(y!, m! - 1, d! + dayOffset));
  const targetY = targetDate.getUTCFullYear();
  const targetM = targetDate.getUTCMonth() + 1;
  const targetD = targetDate.getUTCDate();

  // 以 UTC 同名时刻为起点，按门店时区的实际偏移量修正，最多两轮即可收敛。
  let guess = Date.UTC(targetY, targetM - 1, targetD, Math.floor(minuteOfDay / 60), minuteOfDay % 60);
  for (let i = 0; i < 3; i += 1) {
    const w = wallClock(new Date(guess), timezone);
    const actual = w.hour * 60 + w.minute;
    const actualDayDelta =
      Date.UTC(w.year, w.month - 1, w.day) - Date.UTC(targetY, targetM - 1, targetD);
    const driftMinutes = actualDayDelta / 60000 + (actual - minuteOfDay);
    if (driftMinutes === 0) break;
    guess -= driftMinutes * 60000;
  }
  return new Date(guess).toISOString();
}

/** `HH:mm`，用于界面显示。 */
export function formatWallTime(minutes: number): string {
  const normalized = ((minutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const h = Math.floor(normalized / 60);
  const m = normalized % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** `YYYY-MM-DD` ± n 天。纯日期算术，不涉及时区。 */
export function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const next = new Date(Date.UTC(y!, m! - 1, d! + days));
  return next.toISOString().slice(0, 10);
}

/**
 * ── 呈现层格式化 ────────────────────────────────────────────────────────────
 *
 * ⚠️ **不得直接调用 `new Date(x).toLocaleString()`。** 无参调用同时踩中两个坑：
 * 一是使用浏览器本地时区（违反本文件顶部的约束），二是使用浏览器语言，
 * 与用户在界面上选定的语言不一致 —— 韩语界面里出现英文日期。
 *
 * 以下 hook 统一注入门店时区与当前界面语言。
 */
import { useCallback } from 'react';
import { useLanguage } from '@/LanguageContext';
import { useSession } from '@/lib/session';

/** 界面语言到 Intl locale 标签的映射。Intl 不识别 `zh-Hans` 之外的自定义写法。 */
const INTL_LOCALES: Record<string, string> = {
  'zh-Hans': 'zh-Hans',
  en: 'en-US',
  ko: 'ko-KR',
  es: 'es-ES',
  vi: 'vi-VN',
};

/**
 * 返回一组绑定了门店时区与当前语言的时间格式化函数。
 *
 * 门店时区缺失时（会话尚未就绪）退回 UTC 而非浏览器时区 ——
 * UTC 的偏差是显式且一致的，浏览器时区的偏差则随使用者所在地变化，
 * 会产生「同一张单在两台机器上显示不同日期」这类难以复现的问题。
 */
export function useStoreTime() {
  const { language } = useLanguage();
  const { context } = useSession();
  const timeZone = context?.timezone ?? 'UTC';
  const locale = INTL_LOCALES[language] ?? 'en-US';

  const dateTime = useCallback(
    (iso: string | number | Date | null | undefined, options?: Intl.DateTimeFormatOptions) =>
      iso == null
        ? ''
        : new Date(iso).toLocaleString(locale, {
            timeZone,
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            ...options,
          }),
    [locale, timeZone],
  );

  const date = useCallback(
    (iso: string | number | Date | null | undefined, options?: Intl.DateTimeFormatOptions) =>
      iso == null
        ? ''
        : new Date(iso).toLocaleDateString(locale, { timeZone, ...options }),
    [locale, timeZone],
  );

  const time = useCallback(
    (iso: string | number | Date | null | undefined, options?: Intl.DateTimeFormatOptions) =>
      iso == null
        ? ''
        : new Date(iso).toLocaleTimeString(locale, {
            timeZone,
            hour: '2-digit',
            minute: '2-digit',
            ...options,
          }),
    [locale, timeZone],
  );

  return { dateTime, date, time, timeZone, locale };
}
