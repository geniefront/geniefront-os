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
  isLicenseBilling,
  statusBadgeVariant,
  stripeHostedUrl,
  stripePortalUrl,
  subscriptionNotice,
  subscriptionStatusKey,
} from './display';

const root = dirname(fileURLToPath(import.meta.url));

describe('计费展示：三档正式套餐', () => {
  it('canonical plan 保留独立的语音预约版', () => {
    expect(CANONICAL_PLANS).toEqual(['voice_booking', 'essential', 'growth']);
    expect(canonicalPlan('voice_booking')).toBe('voice_booking');
    expect(planLabelKey('voice_booking')).toBe('settings.stPlanVoiceBooking');
    expect(planNavBadge('voice_booking')).toBe('AI Voice Booking');
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

/**
 * 订阅码付费的门店（迁移 0120）。
 *
 * 这一组是纯函数级的判据，和界面无关 —— 而界面上「说错一句话」的后果
 * 恰恰是从这里开始的：把 license 的门店落进 Stripe 那几档文案，
 * 就会显示一句「X 日自动续费」，而事实是到那天就停。
 */
describe('订阅码付费的展示判据', () => {
  it('expired 有自己的状态文案与红色徽章，不复用 past_due', () => {
    expect(subscriptionStatusKey('expired', false)).toBe('settings.stStatusExpired');
    expect(statusBadgeVariant('expired', false)).toBe('error');
    // past_due 仍然是「还在重试扣款」那一档
    expect(subscriptionStatusKey('past_due', false)).toBe('settings.stStatusPastDue');
  });

  it('license 门店显示「服务有效期至」，而不是续费或期末取消', () => {
    const notice = subscriptionNotice({
      trialing: false, trialEndsAt: null,
      cancelAtPeriodEnd: false, cancelAt: null,
      currentPeriodEnd: '2026-12-31T23:59:59.000Z',
      subscriptionStatus: 'active',
      billingSource: 'license',
      licensePeriodEnd: '2026-12-31T23:59:59.000Z',
    });
    expect(notice.key).toBe('settings.stLicenseUntil');
    expect(notice.date).toBe('2026-12-31T23:59:59.000Z');
  });

  /**
   * ⚠️ 这一条挡的是「顺序写反」。`cancelAtPeriodEnd` 那一档排在前面的话，
   * 一行历史上留下的 true 会让 license 门店显示「已取消」——
   * 而那两列是 Stripe 客户门户的产物，订阅码从来不写它们。
   */
  it('license 判据排在期末取消之前', () => {
    const notice = subscriptionNotice({
      trialing: false, trialEndsAt: null,
      cancelAtPeriodEnd: true, cancelAt: '2026-10-01T00:00:00.000Z',
      currentPeriodEnd: '2026-12-31T23:59:59.000Z',
      subscriptionStatus: 'active',
      billingSource: 'license',
      licensePeriodEnd: '2026-12-31T23:59:59.000Z',
    });
    expect(notice.key).toBe('settings.stLicenseUntil');
  });

  it('license 到期后说清「只读」，而不是「已取消」', () => {
    const notice = subscriptionNotice({
      trialing: false, trialEndsAt: null,
      cancelAtPeriodEnd: false, cancelAt: null,
      currentPeriodEnd: '2026-09-01T00:00:00.000Z',
      subscriptionStatus: 'expired',
      billingSource: 'license',
      licensePeriodEnd: '2026-09-01T00:00:00.000Z',
    });
    expect(notice.key).toBe('settings.stLicenseExpired');
  });

  it('Stripe 门店的四档判据一个都没被改动', () => {
    const base = {
      trialing: false, trialEndsAt: null,
      cancelAtPeriodEnd: false, cancelAt: null,
      currentPeriodEnd: '2026-10-01T00:00:00.000Z',
      subscriptionStatus: 'active',
      billingSource: 'stripe',
      licensePeriodEnd: null,
    };
    expect(subscriptionNotice(base).key).toBe('settings.stRenewsOn');
    expect(subscriptionNotice({ ...base, cancelAtPeriodEnd: true }).key).toBe('settings.stCancelsOn');
    expect(subscriptionNotice({ ...base, subscriptionStatus: 'none' }).key)
      .toBe('settings.stNoSubscriptionHint');
    expect(subscriptionNotice({
      ...base, trialing: true, trialEndsAt: '2026-09-15T00:00:00.000Z',
    }).key).toBe('settings.stTrialEnds');
  });

  it('isLicenseBilling 只看 billingSource', () => {
    expect(isLicenseBilling({ billingSource: 'license' })).toBe(true);
    expect(isLicenseBilling({ billingSource: 'stripe' })).toBe(false);
    expect(isLicenseBilling({ billingSource: 'none' })).toBe(false);
    expect(isLicenseBilling(null)).toBe(false);
  });
});
