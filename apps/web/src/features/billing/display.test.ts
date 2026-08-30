import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CANONICAL_PLANS,
  canonicalPlan,
  formatIsoDate,
  formatUsdFromCents,
  planLabelKey,
  planNavBadge,
  PORTAL_RETURN_PATH,
  statusBadgeVariant,
  stripeHostedUrl,
  stripePortalUrl,
  subscriptionStatusKey,
} from './display';

const root = dirname(fileURLToPath(import.meta.url));

describe('计费展示：只认 Essential / Growth', () => {
  it('canonical plan 只有 essential 与 growth', () => {
    expect(CANONICAL_PLANS).toEqual(['essential', 'growth']);
    expect(canonicalPlan('essential')).toBe('essential');
    expect(canonicalPlan('growth')).toBe('growth');
    expect(canonicalPlan('starter')).toBeNull();
    expect(canonicalPlan('enterprise')).toBeNull();
    expect(planLabelKey('essential')).toBe('settings.stPlanEssential');
    expect(planLabelKey('growth')).toBe('settings.stPlanGrowth');
    expect(planNavBadge('essential')).toBe('Essential');
    expect(planNavBadge('growth')).toBe('Growth');
    expect(planNavBadge('starter')).toBeUndefined();
  });

  it('Essential 试用显示试用，而不是 Growth active', () => {
    expect(subscriptionStatusKey('trialing', true)).toBe('settings.stStatusTrial');
    expect(subscriptionStatusKey('active', true)).toBe('settings.stStatusTrial');
    expect(planLabelKey('essential')).not.toBe('settings.stPlanGrowth');
    expect(statusBadgeVariant('trialing', true)).not.toBe('success');
  });

  it('past_due Essential 显示逾期，不是 active Growth', () => {
    expect(canonicalPlan('essential')).toBe('essential');
    expect(subscriptionStatusKey('past_due', false)).toBe('settings.stStatusPastDue');
    expect(statusBadgeVariant('past_due', false)).toBe('warning');
    expect(planNavBadge('essential')).toBe('Essential');
  });

  it('金额按整数分格式化', () => {
    expect(formatUsdFromCents(9900)).toBe('$99.00');
    expect(formatUsdFromCents(19900)).toBe('$199.00');
    expect(formatUsdFromCents(5)).toBe('$0.05');
    expect(formatIsoDate('2026-09-01T12:00:00.000Z')).toBe('2026-09-01');
  });
});

describe('Stripe 门户 URL', () => {
  it('缺 URL 不能当成成功', () => {
    expect(stripePortalUrl(undefined)).toBeNull();
    expect(stripePortalUrl({ url: null })).toBeNull();
    expect(stripePortalUrl({ url: '' })).toBeNull();
    expect(stripePortalUrl({ url: 'javascript:alert(1)' })).toBeNull();
  });

  it('合法 https URL 才打开', () => {
    expect(stripePortalUrl({ url: 'https://billing.stripe.com/session/abc' }))
      .toBe('https://billing.stripe.com/session/abc');
    expect(stripeHostedUrl({ url: 'https://checkout.stripe.com/c/pay/cs_test' }))
      .toBe('https://checkout.stripe.com/c/pay/cs_test');
    expect(stripeHostedUrl({ url: null })).toBeNull();
  });

  it('前端回跳是相对路径 /settings?tab=billing', () => {
    expect(PORTAL_RETURN_PATH).toBe('/settings?tab=billing');
    expect(PORTAL_RETURN_PATH.startsWith('/')).toBe(true);
    expect(PORTAL_RETURN_PATH.startsWith('//')).toBe(false);
  });
});

describe('Settings 账单写路径不再包含假套餐', () => {
  it('Settings 与 BillingPanel 不再调用 billing.changePlan，也不渲染假发票', () => {
    const settings = readFileSync(resolve(root, '../../pages/Settings.tsx'), 'utf8');
    const panel = readFileSync(resolve(root, './BillingPanel.tsx'), 'utf8');
    const api = readFileSync(resolve(root, './api.ts'), 'utf8');
    expect(settings).not.toMatch(/useChangePlanMutation/);
    expect(settings).not.toMatch(/billing\.changePlan/);
    expect(api).not.toMatch(/billing\.changePlan/);
    expect(settings).not.toMatch(/INV-2026/);
    expect(settings).not.toMatch(/stGrowthActive/);
    expect(settings).not.toMatch(/stUpgradeEnterprise/);
    expect(panel).not.toMatch(/billing\.changePlan/);
    expect(panel).not.toMatch(/stPlanStarter/);
    expect(panel).not.toMatch(/stPlanEnterprise/);
    expect(panel).not.toMatch(/INV-2026/);
    expect(panel).not.toMatch(/setConfirmChangePlan/);
    expect(panel).not.toMatch(/billing\.buyAddon/);
    expect(panel).not.toMatch(/useBuyAddonMutation/);
    expect(api).not.toMatch(/billing\.buyAddon/);
    expect(api).not.toMatch(/useBuyAddonMutation/);
  });
});
