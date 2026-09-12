import { test, expect } from '../fixtures';
import { evidence, loginDesk } from '../helpers';
import { QA_NOW } from '../env';
import { qaEmail, seedScenario } from '../seed';

test.describe('daily operations lifecycle', () => {
  test.describe.configure({ timeout: 120_000 });
  test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(new Date(QA_NOW));
  });
  test('the pre-seeded in-service visit can be completed', async ({ page }) => {
    await seedScenario('busy_shop');
    await loginDesk(page, qaEmail('busy_shop'), '/queue');
    await expect(page.getByText('Emily Stone', { exact: true }).first()).toBeVisible();
    await page.getByRole('button', { name: /Finish and calculate the bill|完工核算账单/ }).first().click();
    await page.getByRole('button', { name: /Confirm completion.*awaiting payment|确认完工并转入待收银/ }).click();
    await expect(page.getByText(/no active service|当前没有已开始且可完成的项目/i)).toHaveCount(0);
    await expect(page.getByText('Emily Stone', { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /Settle and print the receipt|结算收银出票/ }).first()).toBeVisible();
    await evidence(page, 'qa-002-seeded-in-service-completed');
  });

  test('gift-card issue, schedule, queue, rotation, service, tip, and inline checkout complete', async ({ page }) => {
    await seedScenario('busy_shop');
    await loginDesk(page, qaEmail('busy_shop'), '/marketing');
    await page.getByRole('tab', { name: /Gift card sales|礼品卡/i }).click();
    await page.getByRole('button', { name: /Issue a gift card|发售礼品卡/ }).first().click();
    const issueDialog = page.getByRole('dialog');
    await issueDialog.locator('input[type="number"]').nth(0).fill('100');
    await issueDialog.locator('input[type="number"]').nth(1).fill('80');
    await issueDialog.getByPlaceholder(/e\.g\. David|如 David/).fill('Browser QA Purchaser');
    await issueDialog.getByPlaceholder(/e\.g\. Lisa|如 Lisa/).fill('Lisa Park');
    await issueDialog.getByRole('button', { name: /Confirm issue|确认发售/ }).click();
    await expect(page.getByText(/gift card.*issued|礼品卡.*发售/i).first()).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByText(/Total\s+1\s+cards|共\s+1\s+张卡/i)).toBeVisible();
    const issuedCode = (await page.locator('span.font-mono').allTextContents())
      .map((value) => value.trim())
      .find((value) => /^[A-Z0-9-]{16,}$/.test(value.replace(/\s/g, '')));
    expect(issuedCode).toBeTruthy();

    await page.goto('/rotation');
    await expect(page.getByText('Busy Tech', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Busy Tech Two', { exact: true }).first()).toBeVisible();

    await page.goto('/queue');
    await expect(page.getByText('Emily Stone', { exact: true }).first()).toBeVisible();
    await page.getByRole('button', { name: /Finish and calculate the bill|完工核算账单/ }).first().click();
    await page.getByRole('button', { name: /Confirm completion.*awaiting payment|确认完工并转入待收银/ }).click();
    await page.getByRole('button', { name: /Settle and print the receipt|结算收银出票/ }).first().click();
    await page.getByRole('button', { name: /No tip/i }).click();
    await page.getByRole('button', { name: /Gift card/i }).click();
    await page.getByPlaceholder('GF-GC-XXXX').fill(issuedCode!);
    await page.getByRole('button', { name: /Verify|核验/ }).click();
    await expect(page.getByText(/Available balance: \$100\.00|可用余额.*100\.00/i)).toBeVisible();
    await page.getByRole('button', { name: /Complete payment|确认收银|完成支付/i }).click();
    await expect(page.getByText(/Payment complete.*Emily Stone|Emily Stone has been settled|Emily Stone 结账成功/i).first()).toBeVisible();
    await evidence(page, 'operations-gift-card-checkout-complete');
  });

  test('counted day closes and remains closed after reload', async ({ page }) => {
    await seedScenario('day_close_ready');
    await loginDesk(page, qaEmail('day_close_ready'), '/day-close');
    await expect(page.getByText(/Drawer balances exactly|钱箱账实相符/i).first()).toBeVisible();
    await page.getByRole('button', { name: /Close the day|确认封账/i }).click();
    await page.getByRole('dialog').getByRole('button', { name: /Close the day|确认封账/ }).click();
    await expect(page.getByText(/Closed and locked|已正式打烊封账/i).first()).toBeVisible();
    await page.reload();
    await expect(page.getByText(/Closed and locked|已正式打烊封账/i).first()).toBeVisible();
    await evidence(page, 'day-close-finalized');
  });
});
