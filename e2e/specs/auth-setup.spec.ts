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

    const next = () => page.getByRole('button', { name: /^(Next|下一步)$/ }).click();

    // 第 1 步 · 门店资料 —— 自动保存，下一步进入「员工基础设置」（第 2 步）。
    await page.getByRole('button', { name: '七天使用周一时间' }).click();
    await expect(page.getByRole('button', { name: '保存并继续' })).toHaveCount(0);
    await next();
    await expect(page.getByRole('heading', { name: '员工基础设置' }).first()).toBeVisible();
    await evidence(page, 'qa-001-save-and-continue-advances');

    // 第 2 步 · 员工基础设置（可选）—— 直接下一步。
    await next();
    await expect(page.getByRole('heading', { name: '设置房间与工位' }).first()).toBeVisible();

    // 第 3 步 · 房间（门槛）—— 加一个「大厅」房间。
    await page.getByLabel('名称').fill('Browser QA Hall');
    await page.getByRole('button', { name: '添加房间' }).click();
    await expect(page.getByText('Browser QA Hall')).toBeVisible();
    await next();
    await expect(page.getByRole('heading', { name: '设置项目与价格' }).first()).toBeVisible();

    // 第 4 步 · 服务项目（门槛）—— 手工加一个项目。
    await page.getByLabel('项目名称', { exact: true }).first().fill('Browser QA Manicure');
    await page.getByLabel('价格（美元）', { exact: true }).first().fill('42.50');
    await page.getByLabel('时长（分钟）', { exact: true }).first().fill('45');
    await page.getByRole('button', { name: '添加项目' }).click();
    await expect(page.locator('input[value="Browser QA Manicure"]')).toBeVisible();
    await next();
    await expect(page.getByRole('heading', { name: '设置员工与接单能力' }).first()).toBeVisible();

    // 第 5 步 · 员工与排班（门槛）—— 加一个可接单员工。
    await page.getByLabel('员工姓名', { exact: true }).first().fill('Browser QA Tech');
    await page.getByRole('button', { name: '添加员工' }).click();
    await expect(page.locator('input[value="Browser QA Tech"]')).toBeVisible();
    await next();
    await expect(page.getByRole('heading', { name: '功能设置' }).first()).toBeVisible();

    // 第 6 步 · 功能设置（可选，两开关默认关）—— 下一步进入 launch。
    await next();
    await expect(page.getByRole('heading', { name: '检查并正式开店' }).first()).toBeVisible();

    // 第 7 步 · 检查并开店 —— 门槛项全绿（检查项来自后端 readiness）。
    await expect(page.getByText('门店资料和时区已确认')).toBeVisible();
    await expect(page.getByText('至少有一个可用房间')).toBeVisible();
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
