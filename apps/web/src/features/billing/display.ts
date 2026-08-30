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
