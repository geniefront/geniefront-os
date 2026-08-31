import { test, expect } from '../fixtures';
import { evidence, loginDesk } from '../helpers';
import { qaEmail, seedScenario } from '../seed';

test.describe('desk authentication and setup', () => {
  test('login preserves a deep link, survives reload, and logout clears the session', async ({ page, qaRuntime }) => {
    await seedScenario('essential_trial');
    qaRuntime.allowRequestFailure(/\/auth\/v1\/logout\?scope=global$/, 'local GoTrue aborts after clearing the browser session');
    await loginDesk(page, qaEmail('essential_trial'), '/settings?tab=billing');

    await expect(page).toHaveURL(/\/settings\?tab=billing$/);
    await expect(page.getByText(/Essential/).first()).toBeVisible();
    await page.reload();
    await expect(page).toHaveURL(/\/settings\?tab=billing$/);
    await expect(page.getByText(/Essential/).first()).toBeVisible();

    await page.goto('/profile');
    await page.getByRole('button', { name: 'Sign out' }).first().click();
    await page.getByRole('dialog').getByRole('button', { name: /Sign out|确认退出/ }).click();
    await expect(page.locator('#login-email')).toBeVisible();
    await page.waitForTimeout(1_000);
    await page.reload();
    await expect(page.locator('#login-email')).toBeVisible();
  });

  test('Growth setup wizard blocks deep links, persists every required step, and launches the shop', async ({ page }) => {
    await seedScenario('growth_setup');
    await loginDesk(page, qaEmail('growth_setup'), '/dashboard');
    await expect(page).toHaveURL(/\/setup$/);

    await page.getByRole('button', { name: '七天使用周一时间' }).click();
    await page.getByRole('button', { name: '保存并继续' }).click();
    await expect(page.getByRole('heading', { name: '设置项目与价格' }).first()).toBeVisible();
    await evidence(page, 'qa-001-save-and-continue-advances');

    await page.getByLabel('项目名称').fill('Browser QA Manicure');
    await page.getByLabel('价格（美元）').fill('42.50');
    await page.getByLabel('时长（分钟）').fill('45');
    await page.getByRole('button', { name: '添加项目' }).click();
    await expect(page.getByText('Browser QA Manicure')).toBeVisible();
    await page.getByRole('button', { name: /Next|下一步/ }).click();

    await page.getByLabel('员工姓名').fill('Browser QA Tech');
    await page.getByRole('button', { name: '添加员工' }).click();
    await expect(page.getByText('Browser QA Tech')).toBeVisible();
    await page.getByRole('button', { name: /Next|下一步/ }).click();

    await expect(page.getByText('门店资料和时区已确认')).toBeVisible();
    await expect(page.getByText('至少有一个启用项目')).toBeVisible();
    await expect(page.getByText('至少有一位可接单员工')).toBeVisible();
    await evidence(page, 'known-3-setup-ready');
    await page.getByRole('button', { name: '正式开店' }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
    await page.reload();
    await expect(page).toHaveURL(/\/dashboard$/);
    await page.goto('/settings?tab=billing');
    await expect(page.getByText('Growth', { exact: true }).first()).toBeVisible();
  });
});
