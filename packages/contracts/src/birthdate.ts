/**
 * 生日 / date-only 输入的共用校验规则（Web 前台、iPad 自助、公开健康表、客户档案）。
 *
 * 全部按门店日历日处理，`YYYY-MM-DD` 存储，不转 UTC timestamp，不用营业日 cutoff。
 * 纯函数、无框架依赖 —— UI 组件各自实现，规则只此一份（`04` §9.2）。
 */

export interface BirthdateParts {
  /** 4 位年，允许编辑中途为空 / 不足 4 位 */
  year: string;
  /** 1–12，字符串（select 值） */
  month: string;
  /** 1–31，字符串 */
  day: string;
}

export const EMPTY_BIRTHDATE_PARTS: BirthdateParts = { year: '', month: '', day: '' };

/** 某年某月的天数；`month` 为 1–12。非法入参返回 31（宽松，交由 `parseBirthdate` 兜底）。 */
export function daysInMonth(year: number, month: number): number {
  if (!Number.isInteger(month) || month < 1 || month > 12) return 31;
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** `YYYY-MM-DD` → 三字段；非法或空串返回空三字段（用于回显）。 */
export function isoToParts(iso: string | null | undefined): BirthdateParts {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((iso ?? '').trim());
  if (!m) return { ...EMPTY_BIRTHDATE_PARTS };
  return { year: m[1]!, month: String(Number(m[2])), day: String(Number(m[3])) };
}

/** 三字段 → `YYYY-MM-DD`；任一字段空 / 越界返回 null（不代表错误，可能还在编辑）。 */
export function partsToISO(parts: BirthdateParts): string | null {
  const y = parts.year.trim();
  const mo = Number(parts.month);
  const d = Number(parts.day);
  if (!/^\d{4}$/.test(y)) return null;
  if (!Number.isInteger(mo) || mo < 1 || mo > 12) return null;
  if (!Number.isInteger(d) || d < 1 || d > 31) return null;
  const yr = Number(y);
  if (d > daysInMonth(yr, mo)) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export type BirthdateError = 'incomplete' | 'format' | 'invalid_date' | 'future';

export type BirthdateResult =
  | { ok: true; value: string | null }
  | { ok: false; reason: BirthdateError };

export interface BirthdateOptions {
  /** 门店日历今天 `YYYY-MM-DD`。给出时拒绝未来日期；未加载时不传 —— 不拿设备 / UTC 日期误判。 */
  today?: string | null;
  /** 模板未要求生日时允许留空。 */
  optional?: boolean;
}

/**
 * 校验一个已拼好的 `YYYY-MM-DD`（或空串）。
 *
 * - 空串：`optional` 时 `{ ok: true, value: null }`，否则 `incomplete`。
 * - 非 `YYYY-MM-DD`：`format`。
 * - 非真实日历日（2 月 30、1900-02-29 等）：`invalid_date`。
 * - 晚于 `today`：`future`（`today` 未给时不判未来）。
 */
export function parseBirthdate(iso: string | null | undefined, opts: BirthdateOptions = {}): BirthdateResult {
  const raw = (iso ?? '').trim();
  if (!raw) return opts.optional ? { ok: true, value: null } : { ok: false, reason: 'incomplete' };

  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!m) return { ok: false, reason: 'format' };

  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    return { ok: false, reason: 'invalid_date' };
  }

  if (opts.today && /^\d{4}-\d{2}-\d{2}$/.test(opts.today) && raw > opts.today) {
    return { ok: false, reason: 'future' };
  }

  return { ok: true, value: raw };
}

/** 三字段直接校验（先 `partsToISO` 再 `parseBirthdate`），区分「填了一半」与「格式错」。 */
export function parseBirthdateParts(parts: BirthdateParts, opts: BirthdateOptions = {}): BirthdateResult {
  const anyFilled = Boolean(parts.year.trim() || parts.month.trim() || parts.day.trim());
  if (!anyFilled) return opts.optional ? { ok: true, value: null } : { ok: false, reason: 'incomplete' };

  const iso = partsToISO(parts);
  if (!iso) {
    // 年不足 4 位 / 月日未选 = 还没填完；年满 4 位且月日已选但拼不出 = 该月无此日
    const complete = /^\d{4}$/.test(parts.year.trim()) && parts.month.trim() !== '' && parts.day.trim() !== '';
    return { ok: false, reason: complete ? 'invalid_date' : 'incomplete' };
  }
  return parseBirthdate(iso, opts);
}
