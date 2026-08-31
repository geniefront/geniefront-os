import { test, expect } from '../fixtures';
import { evidence, loginDesk, loginPlatform } from '../helpers';
import { qaEmail, seedScenario } from '../seed';

test.describe('API, platform, and marketing surfaces', () => {
  test('API health is available to the browser without tenant headers', async ({ request }) => {
    const response = await request.get('http://127.0.0.1:3000/health');
    expect(response.status()).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true });
  });

  test('active platform operator is allowed', async ({ page }) => {
    await seedScenario('platform_operator');
    await loginPlatform(page, qaEmail('platform_operator'));
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  });

  test('revoked operator is denied', async ({ page, qaRuntime }) => {
    await seedScenario('revoked_platform_operator');
    qaRuntime.allowResponse(/\/v1\/platform\/session$/, 403, 'revoked operator denial');
    await loginPlatform(page, qaEmail('revoked_platform_operator'));
    await expect(page.getByRole('heading', { name: 'Access denied' })).toBeVisible();
  });

  test('store owner is denied platform access', async ({ page, qaRuntime }) => {
    await seedScenario('owner');
    qaRuntime.allowResponse(/\/v1\/platform\/session$/, 403, 'store owner denial');
    await loginPlatform(page, qaEmail('owner'));
    await expect(page.getByRole('heading', { name: 'Access denied' })).toBeVisible();
  });

  test('marketing submits Essential/Growth signup UI and verifies success sessions', async ({ page }) => {
    const submittedPlans: string[] = [];
    await page.route('**/v1/public/signup-checkout', async (route) => {
      const body = route.request().postDataJSON() as { plan: string };
      submittedPlans.push(body.plan);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ url: `https://checkout.stripe.com/c/pay/qa-${body.plan}` }),
      });
    });
    await page.route('https://checkout.stripe.com/**', (route) => route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<h1>Stripe TEST signup checkout</h1>',
    }));
    await page.goto('http://127.0.0.1:5180/');
    await expect(page.getByTestId('plan-essential')).toContainText('$99');
    await expect(page.getByTestId('plan-growth')).toContainText('$199');
    await page.getByTestId('shop-name').fill('QA Essential Signup');
    await page.getByTestId('owner-email').fill('essential-signup@example.test');
    await page.getByTestId('cta-essential').click();
    await expect(page.getByRole('heading', { name: 'Stripe TEST signup checkout' })).toBeVisible();

    await page.goto('http://127.0.0.1:5180/');
    await page.getByTestId('shop-name').fill('QA Growth Signup');
    await page.getByTestId('owner-email').fill('growth-signup@example.test');
    await page.getByTestId('cta-growth').click();
    await expect(page.getByRole('heading', { name: 'Stripe TEST signup checkout' })).toBeVisible();
    expect(submittedPlans).toEqual(['essential', 'growth']);

    await page.goto('http://127.0.0.1:5180/signup/success');
    await expect(page.getByTestId('success-state')).toHaveText('invalid');
    await expect(page.getByTestId('success-message')).toContainText('No payment has been verified');

    await page.route('**/v1/public/signup-session?session_id=*', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'confirmed', plan: 'growth' }),
    }));
    await page.goto('http://127.0.0.1:5180/signup/success?session_id=cs_test_browsergrowth12345');
    await expect(page.getByTestId('success-state')).toHaveText('confirmed');
    await expect(page.getByTestId('success-message')).toContainText('Checkout completed');
  });

  test('desk login remains separate from platform operator access', async ({ page }) => {
    await seedScenario('platform_operator');
    await loginDesk(page, qaEmail('platform_operator'), '/dashboard');
    await expect(page.getByText(/No location is available for this account/i)).toBeVisible();
  });

  test('10DLC pending state is consistent from customer settings through internal review', async ({ page }) => {
    await seedScenario('ten_dlc_pending');
    await loginDesk(page, qaEmail('ten_dlc_pending'), '/settings?tab=10dlc');
    await expect(page.getByText(/pending internal review|内部审核中/i).first()).toBeVisible();

    await loginPlatform(page, qaEmail('ten_dlc_pending.operator'));
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await page.goto('http://127.0.0.1:5179/10dlc');
    await page.getByRole('link', { name: '10DLC Nails' }).click();
    await expect(page.getByText('pending_review', { exact: true }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Mark under review' }).click();
    await expect(page.getByText('under_review', { exact: true })).toBeVisible();
    await evidence(page, '10dlc-platform-under-review');
  });

  test('desk owner can submit a support request that platform then handles', async ({ page }) => {
    await seedScenario('support_request_open');
    await loginDesk(page, qaEmail('support_request_open'), '/support');
    await expect(page.getByRole('heading', { name: /Contact GenieFront support|联系 GenieFront 支持/ })).toBeVisible();
    await page.getByRole('textbox', { name: /Subject|主题/ }).fill('Browser QA desk request');
    await page.getByRole('textbox', { name: /Message|说明/ }).fill('Need help verifying the customer support path.');
    await page.getByRole('button', { name: /Submit request|提交请求/ }).click();
    await expect(page.getByText(/Support request submitted|支持请求已提交/).first()).toBeVisible();
    await evidence(page, 'qa-006-desk-support-submitted');

    await loginPlatform(page, qaEmail('support_request_open.operator'));
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await page.goto('http://127.0.0.1:5179/support');
    await page.getByRole('link', { name: 'QA open request' }).click();
    await page.getByPlaceholder('Internal note (not shown to the customer)').fill('Browser QA handled this request.');
    await page.getByRole('button', { name: 'Add note' }).click();
    await expect(page.getByText('Browser QA handled this request.')).toBeVisible();
    await page.getByRole('combobox').selectOption('resolved');
    await expect(page.getByRole('combobox')).toHaveValue('resolved');
    await evidence(page, 'support-platform-resolved');
  });
});
