/**
 * 订阅码在运营台这一侧的类型与两个小工具（sql/0120，计划批 8）。
 *
 * 抽成一个文件是因为 Licenses 列表页、门店详情里的计费卡片、以及开店表单
 * 三处要用同一份类型和同一套「钱怎么输入」的规则 —— 而钱的输入规则抄第二遍
 * 就一定会有一处用了 `parseFloat`。
 */

export type LicenseKind = 'subscription' | 'quota_pack' | 'store_open';

export type LicenseRow = {
  codeId: string;
  kind: LicenseKind;
  codePrefix: string;
  plan: string | null;
  durationDays: number | null;
  unit: string | null;
  amount: number | null;
  amountCents: number | null;
  paymentNote: string;
  targetOrgId: string | null;
  targetLocationId: string | null;
  targetLocationName: string | null;
  validUntil: string;
  maxRedemptions: number;
  redeemedCount: number;
  status: 'active' | 'redeemed' | 'revoked';
  issuedAt: string;
  revokedAt: string | null;
  revokeReason: string | null;
};

/** 签发响应。⭐ `code` 是**唯一**一次能看到明文的地方 */
export type IssuedLicense = {
  codeId: string;
  code: string;
  codePrefix: string;
  kind: LicenseKind;
  validUntil: string;
};

export type LicensePanel = {
  account: {
    billingSource: 'none' | 'stripe' | 'license';
    plan: string;
    subscriptionStatus: string;
    licensePeriodEnd: string | null;
    currentPeriodEnd: string | null;
    licenseCodeId: string | null;
    licenseCodePrefix: string | null;
    stripeSubscriptionId: string | null;
    stripeSubscriptionItemId: string | null;
    creditBalance: number;
    voiceMinuteBalance: number;
    manualVoiceMinutes: number | null;
  } | null;
  history: Array<{
    redemptionId: string;
    codeId: string;
    codePrefix: string;
    kind: LicenseKind;
    paymentNote: string;
    amountCents: number | null;
    redeemedAt: string;
    redeemedByUserId: string | null;
    effect: Record<string, unknown>;
  }>;
};

/**
 * 「收了多少钱」→ 整数分。
 *
 * ⚠️ **不许用 `parseFloat`**（宪法第 4 条：金额只用整数分）。
 * `parseFloat('0.1') * 100` 是 10.000000000000002，`Math.round` 能盖住它，
 * 但盖不住 `1.005` 这类真实存在的输入 —— 而这里填错一位数会写进一行发票。
 * 所以按字符串切小数点，整数运算。
 *
 * 返回 `null` = 输入不合法（调用方据此禁用提交，而不是猜一个数）。
 */
export function centsFromUsdInput(raw: string): number | null {
  const t = raw.trim();
  if (t === '') return null;
  const m = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(t);
  if (!m) return null;
  const dollars = Number(m[1]);
  const frac = (m[2] ?? '').padEnd(2, '0');
  return dollars * 100 + Number(frac);
}

/**
 * 输入框里的数量 → 整数。
 *
 * ⚠️ 不用 `Number(x)`：`Number('500.5')` 是 `500.5`，而额度是**个数**，
 * 半个积分没有意义。服务端的 `z.number().int()` 会把它挡下来变成一个 400，
 * 但那时运营看到的是「校验失败」而不是「这一格只能填整数」。
 * （`lint-guards.sh` 第 4 条也会拦 `Number()` 落在金额/数量字段上。）
 *
 * 返回 `null` = 不合法，调用方据此禁用提交而不是猜一个数。
 */
export function intFromInput(raw: string, opts: { min?: number; max?: number } = {}): number | null {
  const t = raw.trim();
  if (!/^-?\d{1,7}$/.test(t)) return null;
  const n = Number.parseInt(t, 10);
  if (!Number.isSafeInteger(n)) return null;
  if (opts.min !== undefined && n < opts.min) return null;
  if (opts.max !== undefined && n > opts.max) return null;
  return n;
}

export function usdFromCents(cents: number | null): string {
  if (cents === null) return '—';
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}$${Math.trunc(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`;
}

/** 一张码的条款写成一行给人看 */
export function licenseTermsText(row: {
  kind: LicenseKind; plan: string | null; durationDays: number | null;
  unit: string | null; amount: number | null;
}): string {
  if (row.kind === 'quota_pack') {
    const unit = row.unit === 'voice_minute' ? 'voice minutes' : 'credits';
    return `${row.amount ?? '?'} ${unit}`;
  }
  const plan = row.plan === 'voice_booking' ? 'AI Voice Booking' : row.plan === 'growth' ? 'Growth' : 'Essential';
  return `${plan} · ${row.durationDays ?? '?'} days`;
}

export const LICENSE_STATUS_STYLE: Record<string, string> = {
  active: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  redeemed: 'bg-slate-100 text-slate-600 border-slate-200',
  revoked: 'bg-red-50 text-red-700 border-red-200',
};
