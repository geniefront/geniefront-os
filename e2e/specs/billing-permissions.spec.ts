import { test, expect } from '../fixtures';
import { evidence, loginDesk } from '../helpers';
import { qaEmail, seedScenario } from '../seed';

test.describe('billing states and role boundaries', () => {
  test('Essential trial displays trial quotas and no paid-active copy', async ({ page }) => {
    await seedScenario('essential_trial');
    await loginDesk(page, qaEmail('essential_trial'), '/settings?tab=billing');
    await expect(page.getByText(/Essential/).first()).toBeVisible();
    await expect(page.getByText(/Trial|trial/).first()).toBeVisible();
    await expect(page.getByText('0 / 20')).toBeVisible();
    await expect(page.getByText(/0 \/ 150/)).toBeVisible();
    await expect(page.getByText(/No payment method on file/)).toBeVisible();
  });

  test('Growth active displays paid quotas and the Stripe-synced payment method', async ({ page }) => {
    await seedScenario('growth_active');
    await loginDesk(page, qaEmail('growth_active'), '/settings?tab=billing');
    await expect(page.getByText(/Growth/).first()).toBeVisible();
    await expect(page.getByText(/Active|active/).first()).toBeVisible();
    await expect(page.getByText('0 / 500')).toBeVisible();
    await expect(page.getByText(/0 \/ 1200/)).toBeVisible();
    await expect(page.getByText(/Payment method: Visa ···· 4242|支付方式: Visa ···· 4242/)).toBeVisible();
    await expect(page.getByRole('button', { name: /Add payment method/ })).toHaveCount(0);
    await evidence(page, 'qa-004-growth-billing-card-on-file');
  });

  test('payment-method handoff, topup handoff, and auto-topup persistence are deterministic', async ({ page }) => {
    await seedScenario('essential_trial');
    await page.route('**/v1/billing/payment-method', async (route) => {
      expect(route.request().postDataJSON()).toMatchObject({
        successUrl: '/settings?tab=billing',
        cancelUrl: '/settings?tab=billing',
      });
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ url: 'https://checkout.stripe.com/c/pay/qa-browser-payment-method' }),
      });
    });
    await page.route('https://checkout.stripe.com/**', (route) => route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<h1>Stripe TEST payment-method handoff</h1>',
    }));
    await loginDesk(page, qaEmail('essential_trial'), '/settings?tab=billing');

    await page.route('**/v1/billing/topup', async (route) => {
      expect(route.request().postDataJSON()).toMatchObject({
        unit: 'credit', successUrl: '/settings?tab=billing', cancelUrl: '/settings?tab=billing',
      });
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ url: 'https://checkout.stripe.com/c/pay/qa-topup', sessionId: 'qa-topup' }),
      });
    });
    await page.getByRole('button', { name: 'Buy $50 AI credits' }).click();
    await expect(page).toHaveURL('https://checkout.stripe.com/c/pay/qa-topup');
    await page.goBack();

    const autoTopupLabel = page.locator('label').filter({ hasText: /Auto-topup \$50 when balance is below 50/ });
    await autoTopupLabel.click();
    await expect(page.getByText('Auto-topup setting saved')).toBeVisible();
    await page.reload();
    await expect(page.locator('label').filter({ hasText: /Auto-topup \$50 when balance is below 50/ }).getByRole('checkbox')).toBeChecked();

    await page.getByRole('button', { name: 'Add payment method' }).click();
    await expect(page.getByRole('heading', { name: 'Stripe TEST payment-method handoff' })).toBeVisible();
  });

  test('past_due remains login-accessible and presents billing recovery state', async ({ page }) => {
    await seedScenario('past_due');
    await loginDesk(page, qaEmail('past_due'), '/settings?tab=billing');
    await expect(page.getByText(/Past due|past due/i).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /Manage subscription/ })).toBeVisible();
  });

  test('owner can reach billing while a pure technician is forced into the tech workspace', async ({ page }) => {
    await seedScenario('owner');
    await loginDesk(page, qaEmail('owner'), '/settings?tab=billing');
    await expect(page.getByText(/Growth/).first()).toBeVisible();

    await page.context().clearCookies();
    await page.evaluate(() => localStorage.clear());
    await seedScenario('tech_only');
    await page.goto('/settings?tab=billing');
    await page.locator('#login-email').fill(qaEmail('tech_only'));
    await page.locator('#login-password').fill('GenieQa!2026');
    await page.getByRole('button', { name: 'Sign In', exact: true }).click();
    await expect(page).toHaveURL(/\/tech\/today$/);
    await expect(page.getByText(/billing|subscription/i)).toHaveCount(0);
  });

  test('front desk can operate desk routes without gaining billing management', async ({ page, qaRuntime }) => {
    await seedScenario('manager_or_front_desk');
    await loginDesk(page, qaEmail('manager_or_front_desk'), '/queue');
    await expect(page).toHaveURL(/\/queue$/);
    qaRuntime.allowResponse(/\/v1\/desk\/(?:settings|billing(?:\/invoices)?)$/, 403, 'front desk settings denial');
    await page.goto('/settings?tab=billing');
    await expect(page.getByText(/You do not have permission to open store settings|没有权限访问系统设置/)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Failed to load system settings' })).toHaveCount(0);
    await expect(page.getByText('PERMISSION_DENIED')).toHaveCount(0);
    await page.reload();
    await expect(page.getByText(/You do not have permission to open store settings|没有权限访问系统设置/)).toBeVisible();
    await evidence(page, 'qa-003-frontdesk-settings-deep-link');
  });
});
