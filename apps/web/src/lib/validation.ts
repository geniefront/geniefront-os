/**
 * 输入格式的判定规则。
 *
 * `lib/formFeedback` 解决的是「错误往哪里放」，本模块解决的是「怎么判对错」。
 * 此前这一半散落在各页的行内正则里，同一件事有好几种写法，而且**多数写法不是
 * 判定，是静默纠正**：
 *
 *   - `dollarsToCents('abc')` 返回 0。它是为结账流程写的宽容解析器，把非数字
 *     一律剔掉再算 —— 用在目录价、次卡价、优惠券面额这些输入框上，用户打错字
 *     会静默存成 $0.00，谁都不会知道，直到某天有人按 0 元卖了一张次卡。
 *   - 技师端记小费的正则不通过时直接 `return`，连提示都没有 —— 技师看到的是
 *     按钮点了没反应。
 *
 * 因此这里的函数**一律返回判定结果而不是纠正后的值**，失败时带上可区分的
 * `reason`，由调用方翻成母语文案（见 `useValidationMessage`）。
 *
 * ⚠️ 本模块不做 i18n、不弹 toast、不碰 DOM，因此可以被纯函数测试完全覆盖。
 */

export type ParseOk<T> = { ok: true; value: T };
export type ParseFail<R extends string> = { ok: false; reason: R };
export type ParseResult<T, R extends string> = ParseOk<T> | ParseFail<R>;

// ── 金额 ──────────────────────────────────────────────────────────────────────

export type MoneyReason = 'empty' | 'format' | 'negative' | 'tooLarge';

export interface MoneyOptions {
  /** 允许留空，留空时判定为 0。用于「不填即不收」的可选金额。 */
  allowEmpty?: boolean;
  /** 允许负数。仅用于调账一类场景，默认不允许。 */
  allowNegative?: boolean;
  /** 上限（整数分）。默认 100 万美元，足以拦住误加一位的手滑。 */
  maxCents?: number;
}

const DEFAULT_MAX_CENTS = 100_000_000; // $1,000,000.00

/**
 * 金额字符串 → 整数分。
 *
 * ⚠️ 全程按字符串解析、整数运算，不用 `Number(x) * 100`：浮点乘法在 `1.005`
 * 这类输入上得到 100.49999999999999，四舍五入后少一分。
 *
 * 小数位超过两位一律**截断**而非进位 —— 宁可少收，不可多收。这一点与
 * `features/checkout/api.ts` 的 `dollarsToCents` 保持一致，两者对合法输入的
 * 结果必须相同；差别只在于本函数会对非法输入说「不」。
 */
export function parseMoney(input: string, options: MoneyOptions = {}): ParseResult<number, MoneyReason> {
  const { allowEmpty = false, allowNegative = false, maxCents = DEFAULT_MAX_CENTS } = options;
  // 去掉货币符号、千分位与空白；这些是书写习惯，不是错误
  const trimmed = input.trim().replace(/[$,\s]/g, '');

  if (trimmed === '') return allowEmpty ? { ok: true, value: 0 } : { ok: false, reason: 'empty' };
  if (!/^-?\d*(?:\.\d*)?$/.test(trimmed) || trimmed === '-' || trimmed === '.' || trimmed === '-.') {
    return { ok: false, reason: 'format' };
  }

  const negative = trimmed.startsWith('-');
  if (negative && !allowNegative) return { ok: false, reason: 'negative' };

  const [whole = '0', frac = ''] = trimmed.replace('-', '').split('.');
  const cents = (Number(whole) || 0) * 100 + Number(`${frac}00`.slice(0, 2));
  if (!Number.isFinite(cents)) return { ok: false, reason: 'format' };
  if (cents > maxCents) return { ok: false, reason: 'tooLarge' };

  return { ok: true, value: negative ? -cents : cents };
}

// ── 时长 ──────────────────────────────────────────────────────────────────────

export type DurationReason = 'empty' | 'format' | 'range';

export interface DurationOptions {
  /** 下限（分钟）。目录项目为 5，预约内的单项覆盖为 1。 */
  min?: number;
  /** 上限（分钟）。 */
  max?: number;
}

/**
 * 服务时长（分钟）。
 *
 * 下限随场景不同：目录里新建项目不允许短于 5 分钟，而预约内对单项的时长覆盖
 * 允许到 1 分钟（前台按实际情况微调）。因此下限由调用方给出，不写死在这里。
 */
export function parseDurationMinutes(
  input: string,
  options: DurationOptions = {},
): ParseResult<number, DurationReason> {
  const { min = 1, max = 600 } = options;
  const trimmed = input.trim();

  if (trimmed === '') return { ok: false, reason: 'empty' };
  if (!/^\d{1,4}$/.test(trimmed)) return { ok: false, reason: 'format' };

  const value = Number(trimmed);
  if (value < min || value > max) return { ok: false, reason: 'range' };
  return { ok: true, value };
}

// ── 邮箱 ──────────────────────────────────────────────────────────────────────

export type EmailReason = 'empty' | 'format';

/**
 * 邮箱地址。
 *
 * ⚠️ 这里刻意只做**形状**检查，不追求 RFC 5322 精确性。完整的邮箱语法允许带
 * 引号的本地部分、注释、IP 字面量等，用正则精确实现只会把合法地址拒之门外；
 * 地址是否真的存在只有发一封信才知道。这道检查的职责仅限于拦住「漏打 @」
 * 「结尾少了域名」这类当场可见的手误。
 */
export function parseEmail(input: string): ParseResult<string, EmailReason> {
  const trimmed = input.trim();
  if (trimmed === '') return { ok: false, reason: 'empty' };
  if (!/^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(trimmed)) return { ok: false, reason: 'format' };
  return { ok: true, value: trimmed.toLowerCase() };
}

// ── 门店 PIN ──────────────────────────────────────────────────────────────────

export type PinReason = 'empty' | 'format';

/** 快捷 PIN：4–6 位数字。长度区间与服务端一致。 */
export function parsePin(input: string): ParseResult<string, PinReason> {
  const trimmed = input.trim();
  if (trimmed === '') return { ok: false, reason: 'empty' };
  if (!/^\d{4,6}$/.test(trimmed)) return { ok: false, reason: 'format' };
  return { ok: true, value: trimmed };
}

// ── 数量 ──────────────────────────────────────────────────────────────────────

export type CountReason = 'empty' | 'format' | 'range';

export interface CountOptions {
  min?: number;
  max?: number;
}

/** 正整数（次卡次数、房间容量、并发上限）。 */
export function parseCount(
  input: string,
  options: CountOptions = {},
): ParseResult<number, CountReason> {
  const { min = 1, max = 9999 } = options;
  const trimmed = input.trim();
  if (trimmed === '') return { ok: false, reason: 'empty' };
  if (!/^\d{1,6}$/.test(trimmed)) return { ok: false, reason: 'format' };
  const value = Number(trimmed);
  if (value < min || value > max) return { ok: false, reason: 'range' };
  return { ok: true, value };
}
