import { test, expect, type Page } from '../fixtures';
import { chooseLocation, evidence, loginDesk } from '../helpers';
import { qaEmail, seedScenario } from '../seed';

function wallDate(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(iso));
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  return `${year}-${month}-${day}`;
}

async function expectNoDocumentOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.client + 1);
}

test.describe('remaining browser QA matrix', () => {
  test.describe.configure({ timeout: 120_000 });

  test('Growth billing exposes $50 credit and voice top-up and records mocked charges', async ({ page }) => {
    const topupUnits: string[] = [];
    await page.route('**/v1/billing/topup', async (route) => {
      const body = route.request().postDataJSON() as { unit: string };
      topupUnits.push(body.unit);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          unit: body.unit,
          units: body.unit === 'credit' ? 1000 : 200,
          balanceAfter: body.unit === 'credit' ? 1000 : 200,
        }),
      });
    });
    await seedScenario('growth_active');
    await loginDesk(page, qaEmail('growth_active'), '/settings?tab=billing');
    await expect(page.getByRole('button', { name: /Buy \$50 AI credits|购买 \$50 AI 积分/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Buy \$50 voice minutes|购买 \$50 语音分钟/ })).toBeVisible();

    await page.getByRole('button', { name: /Buy \$50 AI credits|购买 \$50 AI 积分/ }).click();
    await expect(page.getByText(/Payment confirmed|付款已确认/).first()).toBeVisible();
    await page.getByRole('button', { name: /Buy \$50 voice minutes|购买 \$50 语音分钟/ }).click();
    await expect(page.getByText(/Payment confirmed|付款已确认/).first()).toBeVisible();
    expect(topupUnits).toEqual(['credit', 'voice_minute']);
    await evidence(page, 'billing-credit-and-voice-topup');
  });

  test('auto-topup can be enabled and disabled; threshold is displayed and not editable', async ({ page }) => {
    await seedScenario('growth_active');
    await loginDesk(page, qaEmail('growth_active'), '/settings?tab=billing');

    const creditAuto = page.locator('label').filter({ hasText: /Auto-topup \$50 when balance is below 50|余额低于 50 时自动充 \$50/ });
    const voiceAuto = page.locator('label').filter({ hasText: /Auto-topup \$50 when balance is below 20|余额低于 20 时自动充 \$50/ });
    await expect(creditAuto).toBeVisible();
    await expect(voiceAuto).toBeVisible();
    await expect(page.getByRole('spinbutton')).toHaveCount(0);
    await expect(creditAuto.locator('input[type="number"]')).toHaveCount(0);

    await creditAuto.click();
    await expect(page.getByText(/Auto-topup setting saved|自动续充设置已保存/).first()).toBeVisible();
    await expect(creditAuto.getByRole('checkbox')).toBeChecked();
    await page.reload();
    await expect(creditAuto.getByRole('checkbox')).toBeChecked();

    await creditAuto.click();
    await expect(page.getByText(/Auto-topup setting saved|自动续充设置已保存/).first()).toBeVisible();
    await expect(creditAuto.getByRole('checkbox')).not.toBeChecked();
    await page.reload();
    await expect(creditAuto.getByRole('checkbox')).not.toBeChecked();
    await evidence(page, 'billing-auto-topup-disabled');
  });

  test('10DLC customer submission reaches platform internal review', async ({ page }) => {
    await seedScenario('growth_active');
    await loginDesk(page, qaEmail('growth_active'), '/settings?tab=10dlc');
    await expect(page.getByText(/No 10DLC application has been submitted|尚未向 GenieFront 提交 10DLC 申请/).first()).toBeVisible();

    await page.getByPlaceholder('Lotus Spa & Wellness LLC').fill('Growth Nails LLC');
    await page.getByPlaceholder('12-3456789').fill('98-7654321');
    await page.getByPlaceholder('128 E 56th St, New York, NY 10022').fill('200 QA Avenue, New York, NY 10001');
    await page.getByPlaceholder('Emily Zhang').fill('Growth Owner');
    await page.getByPlaceholder('Store Owner / Manager').fill('Owner');
    await page.getByPlaceholder('owner@lotusspanyc.com').fill('qa+growth_active@example.test');
    await page.getByPlaceholder('(212) 580-8888').fill('(212) 555-0100');
    await page.getByRole('button', { name: /Submit the 10DLC application for GenieFront review|提交 10DLC 申请给 GenieFront 审核/ }).click();
    const confirmSubmit = page.getByRole('button', { name: /Submit for review|确认提交审核/ });
    await confirmSubmit.click();
    await expect(page.getByText(/Your 10DLC application has been received by GenieFront|GenieFront 已收到你的 10DLC 申请/).first()).toBeVisible();
    await expect(page.getByText(/pending internal review|内部审核中|Pending GenieFront review/).first()).toBeVisible();
    await page.reload();
    await expect(page.getByText(/Pending GenieFront review|GenieFront 内部审核中/).first()).toBeVisible();
    await evidence(page, '10dlc-customer-submitted');
  });

  test('marketing cancel path does not claim a shop was created', async ({ page }) => {
    await page.goto('http://127.0.0.1:5180/signup/cancel');
    await expect(page.getByRole('heading', { name: 'Checkout canceled' })).toBeVisible();
    await expect(page.getByText('No shop was created')).toBeVisible();
    await page.getByTestId('retry-pricing').click();
    await expect(page).toHaveURL(/\/#pricing$|\/$/);
    await expect(page.getByTestId('plan-essential')).toBeVisible();
    await expect(page.getByTestId('plan-growth')).toBeVisible();
    await evidence(page, 'marketing-signup-cancel');
  });

  test('desk history, reload, double-submit, and support error states stay coherent', async ({ page, qaRuntime }) => {
    await seedScenario('support_request_open');
    await loginDesk(page, qaEmail('support_request_open'), '/queue');
    await expect(page).toHaveURL(/\/queue$/);
    await page.goto('/schedule');
    await expect(page).toHaveURL(/\/schedule$/);
    await page.goBack();
    await expect(page).toHaveURL(/\/queue$/);
    await page.goForward();
    await expect(page).toHaveURL(/\/schedule$/);
    await page.reload();
    await expect(page).toHaveURL(/\/schedule$/);

    await page.goto('/support');
    const subject = page.getByRole('textbox', { name: /Subject|主题/ });
    const message = page.getByRole('textbox', { name: /Message|说明/ });
    const submitPosts: string[] = [];
    await page.route('**/v1/commands/support.submitRequest', async (route) => {
      submitPosts.push(route.request().postData() ?? '');
      await route.continue();
    });
    await subject.fill('Double-submit QA');
    await message.fill('Please ignore; browser QA double-submit probe.');
    const submit = page.getByRole('button', { name: /Submit request|提交请求/ });
    await Promise.all([submit.click(), submit.click()]);
    await expect(page.getByText(/Support request submitted|支持请求已提交/).first()).toBeVisible();
    expect.soft(submitPosts.length, 'support submit should ignore a second click while the first request is in flight').toBe(1);
    await expect(subject).toHaveValue('');

    await page.unroute('**/v1/commands/support.submitRequest');
    qaRuntime.allowResponse(/\/v1\/commands\/support\.submitRequest$/, 500, 'forced support submit error');
    await page.route('**/v1/commands/support.submitRequest', async (route) => {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'INTERNAL', details: {}, overridable: false }),
      });
    });
    await subject.fill('Error-path QA');
    await message.fill('Forced 500 to verify the error state.');
    await submit.click();
    await expect(subject).toHaveValue('Error-path QA');
    await expect(message).toHaveValue('Forced 500 to verify the error state.');
    await evidence(page, 'support-error-and-history');
  });

  test('KNOWN-2: capture every 4xx after desk login with request URL', async ({ page, qaRuntime }) => {
    qaRuntime.allowResponse(/\/favicon\.ico$/, 404, 'browser default favicon probe');
    await seedScenario('growth_active');
    const fourXx: Array<{ method: string; status: number; url: string }> = [];
    page.on('response', (response) => {
      if (response.status() >= 400) {
        fourXx.push({
          method: response.request().method(),
          status: response.status(),
          url: response.url(),
        });
      }
    });
    await loginDesk(page, qaEmail('growth_active'), '/dashboard');
    await expect(page.getByText(/Growth Nails|增长店/).first()).toBeVisible();
    await page.goto('/queue');
    await page.goto('/schedule');
    await page.goto('/settings?tab=billing');
    await page.waitForTimeout(2_000);
    const unexplained = fourXx.filter((item) => !/\/favicon\.ico$/.test(new URL(item.url).pathname));
    await test.info().attach('known-2-network-4xx', {
      body: Buffer.from(JSON.stringify({ fourXx, unexplained }, null, 2)),
      contentType: 'application/json',
    });
    await evidence(page, 'known-2-after-login');
    expect(unexplained, `unexpected 4xx after login:\n${unexplained.map((item) => `${item.method} ${item.status} ${item.url}`).join('\n')}`).toEqual([]);
  });

  /*
   * ⚠️ 这两条停在 20:15 / 21:30 —— **cutoff 之后**，此时营业日恰好等于
   * 门店时区的日历日，所以它们只能证明时区那一半是对的。
   * cutoff 那一半（当地午夜到 04:00 的那个窗口）在 `business-day.spec.ts`。
   */
  test('QA-008: every desk Today control uses the shop timezone (evening, after the cutoff)', async ({ page }) => {
    const frozen = '2026-08-31T00:15:00.000Z';
    const shopZone = 'America/New_York';
    const shopToday = wallDate(frozen, shopZone);
    const utcToday = frozen.slice(0, 10);
    await seedScenario('growth_active');
    await page.clock.install({ time: new Date(frozen) });
    await page.clock.resume();
    await loginDesk(page, qaEmail('growth_active'), '/dashboard');

    const dashboardToday = await page.locator('span.font-mono').filter({ hasText: /20\d{2}-\d{2}-\d{2}/ }).first().textContent();
    await page.goto('/schedule');
    await page.getByRole('button', { name: /^(Today|今天)$/ }).click();
    const scheduleAfterToday = await page.locator('input[type="date"]').inputValue();
    await page.goto('/rotation');
    const rotationToday = await page.locator('input[type="date"]').inputValue();
    await page.goto('/day-close');
    await page.getByRole('button', { name: /^(Today|今日)$/ }).click();
    const dayCloseToday = await page.locator('span').filter({ hasText: /20\d{2}-\d{2}-\d{2}/ }).first().textContent();
    await page.getByRole('button', { name: /Yesterday|昨日/ }).click();
    const dayCloseYesterday = await page.locator('span').filter({ hasText: /20\d{2}-\d{2}-\d{2}/ }).first().textContent();

    const report = {
      frozen,
      shopZone,
      shopToday,
      utcToday,
      dashboardToday,
      scheduleAfterToday,
      rotationToday,
      dayCloseToday,
      dayCloseYesterday,
    };
    await test.info().attach('timezone-ny-evening', {
      body: Buffer.from(JSON.stringify(report, null, 2)),
      contentType: 'application/json',
    });
    await evidence(page, 'timezone-ny-evening-rotation');

    expect.soft(shopToday).toBe('2026-08-30');
    expect.soft(utcToday).toBe('2026-08-31');
    expect.soft(rotationToday).toBe(shopToday);
    expect.soft(scheduleAfterToday).toBe(shopToday);
    expect.soft(dayCloseYesterday).toBe('2026-08-29');
  });

  test('QA-008: West shop Today uses its own timezone, not the browser timezone', async ({ page }) => {
    const frozen = '2026-08-31T04:30:00.000Z';
    const shopZone = 'America/Los_Angeles';
    const browserZone = 'America/New_York';
    const shopToday = wallDate(frozen, shopZone);
    const browserToday = wallDate(frozen, browserZone);
    await seedScenario('multi_location_owner');
    await page.clock.install({ time: new Date(frozen) });
    await page.clock.resume();
    await loginDesk(page, qaEmail('multi_location_owner'), '/schedule');
    await chooseLocation(page, 'West Side Spa');
    await page.goto('/dashboard');
    const dashboardToday = await page.locator('span.font-mono').filter({ hasText: /20\d{2}-\d{2}-\d{2}/ }).first().textContent();
    await page.goto('/schedule');
    const scheduleInitial = await page.locator('input[type="date"]').inputValue();
    await page.getByRole('button', { name: /^(Today|今天)$/ }).click();
    const scheduleAfterToday = await page.locator('input[type="date"]').inputValue();
    await page.goto('/rotation');
    const rotationToday = await page.locator('input[type="date"]').inputValue();

    const report = {
      frozen,
      shopZone,
      browserZone,
      shopToday,
      browserToday,
      dashboardToday,
      scheduleInitial,
      scheduleAfterToday,
      rotationToday,
    };
    await test.info().attach('timezone-la-vs-ny-browser', {
      body: Buffer.from(JSON.stringify(report, null, 2)),
      contentType: 'application/json',
    });
    await evidence(page, 'timezone-west-shop-today');

    expect.soft(shopToday).toBe('2026-08-30');
    expect.soft(browserToday).toBe('2026-08-31');
    expect.soft(scheduleAfterToday).toBe(shopToday);
    expect.soft(rotationToday).toBe(shopToday);
  });

  test('critical desk flows remain usable on desktop, tablet, and a narrow viewport', async ({ page }) => {
    await seedScenario('busy_shop');
    await loginDesk(page, qaEmail('busy_shop'), '/queue');
    for (const viewport of [
      { name: 'desktop', width: 1280, height: 720 },
      { name: 'tablet', width: 820, height: 1180 },
      { name: 'narrow', width: 390, height: 844 },
    ] as const) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('/queue');
      if (viewport.name === 'narrow') {
        await expect(page.getByRole('button', { name: /Open navigation|打开导航/ })).toBeVisible();
      }
      await expect(page.getByText('Emily Stone', { exact: true }).first()).toBeVisible();
      await expectNoDocumentOverflow(page);
      await page.goto('/day-close');
      await expectNoDocumentOverflow(page);
      await evidence(page, `responsive-${viewport.name}-queue-dayclose`);
    }
  });

  test('past_due remains on billing recovery and blocks a catalog write', async ({ page, qaRuntime }) => {
    await seedScenario('past_due');
    await loginDesk(page, qaEmail('past_due'), '/settings?tab=billing');
    await expect(page.getByText(/Past due|past due/i).first()).toBeVisible();
    qaRuntime.allowResponse(/\/v1\/commands\/catalog\.saveService$/, 403, 'past_due catalog freeze');
    await page.goto('/settings?tab=services');
    const name = page.getByLabel(/Service name|项目名称/).or(page.getByPlaceholder(/Manicure|美甲/));
    if (await name.count()) {
      await name.first().fill('Past Due Probe');
      const add = page.getByRole('button', { name: /Add service|添加项目|Save|保存/ }).first();
      if (await add.count()) await add.click();
      await expect(page.getByText(/PAST_DUE|past due|订阅已逾期|欠费/i).first()).toBeVisible();
    }
    await evidence(page, 'past-due-write-blocked');
  });
});
