import { test, expect } from '../fixtures';
import { evidence, loginDesk } from '../helpers';
import { qaEmail, seedScenario } from '../seed';

async function expectNoDocumentOverflow(page: import('@playwright/test').Page) {
  const dimensions = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.client + 1);
}

test('tablet and narrow layouts retain navigation without document overflow', async ({ page }) => {
  await seedScenario('growth_active');
  await page.setViewportSize({ width: 820, height: 1180 });
  await loginDesk(page, qaEmail('growth_active'), '/dashboard');
  await expectNoDocumentOverflow(page);
  await page.goto('/settings?tab=billing');
  await expect(page.getByText('Growth', { exact: true }).first()).toBeVisible();
  await expectNoDocumentOverflow(page);
  await evidence(page, 'tablet-growth-billing');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expectNoDocumentOverflow(page);
  await page.getByRole('button', { name: /Open navigation|打开导航/ }).click();
  await expect(page.getByRole('link', { name: /Schedule|日程安排/ })).toBeVisible();
  await page.getByRole('link', { name: /Schedule|日程安排/ }).click();
  await expect(page).toHaveURL(/\/schedule$/);
  await expectNoDocumentOverflow(page);
  await evidence(page, 'narrow-schedule');
});
