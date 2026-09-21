import { test, expect } from '../fixtures';
import { loginDesk, evidence } from '../helpers';
import { seedScenario, qaEmail } from '../seed';

test('voice audit pages and autosave survive browser back navigation', async ({ page }) => {
  await seedScenario('voice_active');
  await loginDesk(page, qaEmail('voice_active'), '/customers');
  await expect(page.getByRole('button', { name: /Lisa Park/ }).first()).toBeVisible();
  await page.getByRole('button', { name: /Lisa Park/ }).first().focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/customers\//);
  await page.goto('/settings?tab=store');
  const name = page.getByLabel('Store name', { exact: true });
  await expect(name).toBeVisible();
  await name.fill('Voice autosave browser QA');
  await page.goBack();
  await expect(page).toHaveURL(/\/customers\//);
  await page.goto('/settings?tab=store');
  await expect(name).toHaveValue('Voice autosave browser QA');
  await expect(page.getByText('Changes saved', { exact: true }).last()).toBeVisible();
  await page.reload();
  await expect(name).toHaveValue('Voice autosave browser QA');
  for (const [path, endpoint] of [['/schedule','/v1/desk/day?'],['/calls','/v1/desk/calls?'],['/communication-logs','/v1/desk/communications/deliveries'],['/profile?tab=security','/v1/me/profile'],['/support','/v1/desk/support/requests']]) {
    const responsePromise = page.waitForResponse(response => response.url().includes(endpoint!) && response.request().method() === 'GET');
    await page.goto(path!);
    expect((await responsePromise).status()).toBe(200);
    await expect(page.locator('main')).toBeVisible();
    await expect(page.getByRole('heading', { name: /Something went wrong|Unable to load/ })).toHaveCount(0);
  }
  await page.goto('/profile');
  await page.getByRole('textbox', { name: 'Legal name', exact: true }).fill('Voice QA Profile');
  await page.getByRole('textbox', { name: /Mobile|Phone/, exact: false }).fill('');
  await page.getByRole('button', { name: 'Save', exact: true }).first().click();
  await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Your profile has been saved')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Legal name', exact: true })).toHaveValue('Voice QA Profile');
  await page.goto('/profile?tab=security');
  await expect(page.getByText('Active sessions', { exact: true })).toHaveCount(0);
  await expect(page.getByText('PIN code', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Update password', exact: true })).toBeVisible();
  await evidence(page, 'voice-profile-security');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/customers');
  await expect(page.getByRole('button', { name: /Lisa Park/ }).first()).toBeVisible();
  const width = await page.evaluate(() => ({ content: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth }));
  expect(width.content).toBeLessThanOrEqual(width.viewport + 1);
  for (const action of await page.getByRole('button', { name: /Export all|New customer/ }).all()) {
    const box = await action.boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(width.viewport + 1);
  }
  await evidence(page, 'voice-customers-narrow');
});
