/**
 * Settings → billing 只展示 Stripe 回写后的真实状态。
 * 套餐词汇只有 essential / growth，没有 Starter / Enterprise。
 */

import type { BadgeVariant } from '@/components/ui/Badge';
import type { TranslationKey } from '@/i18n';

export const CANONICAL_PLANS = ['essential', 'growth'] as const;
export type CanonicalPlan = (typeof CANONICAL_PLANS)[number];

export const PORTAL_RETURN_PATH = '/settings?tab=billing';

export function canonicalPlan(plan: string | null | undefined): CanonicalPlan | null {
  return plan === 'essential' || plan === 'growth' ? plan : null;
}

export function planLabelKey(plan: string | null | undefined): TranslationKey {
  if (plan === 'essential') return 'settings.stPlanEssential';
  if (plan === 'growth') return 'settings.stPlanGrowth';
  return 'settings.stPlanUnknown';
}

export function planNavBadge(plan: string | null | undefined): string | undefined {
  if (plan === 'essential') return 'Essential';
  if (plan === 'growth') return 'Growth';
  return undefined;
}

export function subscriptionStatusKey(
  status: string | null | undefined,
  trialing: boolean,
): TranslationKey {
  if (trialing) return 'settings.stStatusTrial';
  switch (status) {
    case 'active':
      return 'settings.stStatusActive';
    case 'past_due':
    case 'unpaid':
    case 'incomplete_expired':
      return 'settings.stStatusPastDue';
    case 'canceled':
      return 'settings.stStatusCanceled';
    case 'trialing':
      return 'settings.stStatusTrial';
    // 从未接过计费（sql/0085）。和「已取消」是两回事：那家店从来没订过，
    // 界面上要给的是「去订阅」而不是「去恢复」
    case 'none':
      return 'settings.stStatusNone';
    default:
      return 'settings.stStatusUnknown';
  }
}

export function statusBadgeVariant(
  status: string | null | undefined,
  trialing: boolean,
): BadgeVariant {
  if (trialing) return 'default';
  if (status === 'active') return 'success';
  if (status === 'past_due' || status === 'unpaid' || status === 'incomplete_expired') {
    return 'warning';
  }
  if (status === 'canceled') return 'secondary';
  return 'outline';
}

/**
 * 订阅那一栏第二行该写什么。
 *
 * ⭐ 顺序是判据本身，不能调：**期末取消排在续期之前**。
 * 反过来的话，一个已经点了取消的账户会被显示成「本期结束日 X」——
 * 而那句话在老板读来是「X 日会自动续费」，正好和事实相反。
 */
export function subscriptionNotice(
  billing: {
    trialing: boolean; trialEndsAt: string | null;
    cancelAtPeriodEnd: boolean; cancelAt: string | null;
    currentPeriodEnd: string | null; subscriptionStatus: string;
  } | null,
): { key: TranslationKey; date: string | null } {
  if (!billing) return { key: 'settings.stPortalHint', date: null };
  if (billing.subscriptionStatus === 'none') {
    return { key: 'settings.stNoSubscriptionHint', date: null };
  }
  if (billing.cancelAtPeriodEnd) {
    return {
      key: 'settings.stCancelsOn',
      date: billing.cancelAt ?? billing.currentPeriodEnd,
    };
  }
  if (billing.trialing && billing.trialEndsAt) {
    return { key: 'settings.stTrialEnds', date: billing.trialEndsAt };
  }
  if (billing.currentPeriodEnd) {
    return { key: 'settings.stRenewsOn', date: billing.currentPeriodEnd };
  }
  return { key: 'settings.stPortalHint', date: null };
}

export function invoiceStatusKey(status: string | null | undefined): TranslationKey {
  if (status === 'paid') return 'settings.stInvoiceStatusPaid';
  if (status === 'pending') return 'settings.stInvoiceStatusPending';
  if (status === 'failed') return 'settings.stInvoiceStatusFailed';
  return 'settings.stStatusUnknown';
}

/** 金额只用整数分，禁止 parseFloat。 */
export function formatUsdFromCents(cents: number): string {
  const negative = cents < 0;
  const abs = negative ? -cents : cents;
  const dollars = Math.trunc(abs / 100);
  const fraction = abs % 100;
  const frac = fraction < 10 ? `0${fraction}` : String(fraction);
  return `${negative ? '-' : ''}$${dollars}.${frac}`;
}

export function formatIsoDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const day = iso.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

export function safeHttpsUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

export function stripePortalUrl(res: { url?: string | null } | null | undefined): string | null {
  return safeHttpsUrl(res?.url);
}

/** Checkout setup / topup hosted pages use the same https-only rule as Portal. */
export function stripeHostedUrl(res: { url?: string | null } | null | undefined): string | null {
  return stripePortalUrl(res);
}

export function isRelativeAppPath(value: string | undefined): value is string {
  return Boolean(value && value.startsWith('/') && !value.startsWith('//') && !value.includes('://'));
}
