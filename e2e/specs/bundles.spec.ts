import { test, expect } from '../fixtures';
import { evidence, loginDesk } from '../helpers';
import { qaEmail, seedScenario } from '../seed';

/**
 * U10 组合套餐：前台目录管理面板的端到端闭环。
 *
 * 覆盖 BundleManagerPanel 全链路 —— 真实 `bundle.saveTemplate` 命令 +
 * `GET /v1/desk/bundles` 查询 + 列表卡渲染（原价合计 / 组合价 / 优惠）。
 * booking → 看板 → 结账的整链需要更多种子数据，留手测（TEST-PLAYBOOK §2）。
 */
test.describe('service bundles (U10)', () => {
  test.describe.configure({ timeout: 120_000 });

  test('owner creates a bundle from the Marketing → Bundles tab', async ({ page }) => {
    await seedScenario('busy_shop');
    await loginDesk(page, qaEmail('busy_shop'), '/marketing');

    await page.getByRole('tab', { name: /Bundles|组合套餐/i }).click();
    await page.getByTestId('bundle-new').click();

    const dialog = page.getByRole('dialog');
    await dialog.getByTestId('bundle-name-zh').fill('放松套餐 QA');
    await dialog.getByTestId('bundle-name-en').fill('Relax Combo QA');

    // 两个执行单元（默认都取第一项服务，够验收「原价合计 / 组合价 / 优惠」）。
    await dialog.getByTestId('bundle-add-component').click();
    await dialog.getByTestId('bundle-add-component').click();
    await expect(dialog.getByTestId('bundle-component-select')).toHaveCount(2);

    await dialog.getByTestId('bundle-price').fill('40');
    await dialog.getByTestId('bundle-save').click();

    await expect(page.getByRole('dialog')).toHaveCount(0);

    const card = page.getByTestId('bundle-card').filter({ hasText: 'Relax Combo QA' });
    await expect(card).toBeVisible();
    await expect(card).toContainText('$40.00');   // 组合价
    await expect(card).toContainText('$50.00');   // 原价合计（Classic Manicure ×2）

    await page.reload();
    await page.getByRole('tab', { name: /Bundles|组合套餐/i }).click();
    await expect(
      page.getByTestId('bundle-card').filter({ hasText: 'Relax Combo QA' }),
    ).toBeVisible();

    await evidence(page, 'u10-bundle-created');
  });
});
