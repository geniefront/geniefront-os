import { test, expect } from '../fixtures';
import { chooseLocation, evidence, loginDesk } from '../helpers';
import { qaEmail, seedScenario } from '../seed';

test('switching locations never renders the other store customer or service data', async ({ page }) => {
  await seedScenario('multi_location_owner');
  await loginDesk(page, qaEmail('multi_location_owner'), '/schedule');

  await expect(page.getByText('East Side Nails')).toBeVisible();
  await expect(page.getByText('West Side Spa')).toBeVisible();
  await chooseLocation(page, 'East Side Nails');
  await page.goto('/customers');
  await expect(page.getByText('Lisa Park')).toBeVisible();
  await expect(page.getByText('David Chen')).toHaveCount(0);

  await page.getByRole('complementary').getByRole('button', { name: /East Side Nails/ }).click();
  await expect(page.getByRole('heading', { name: /Select location/i })).toBeVisible();
  await page.getByRole('button').filter({ hasText: 'West Side Spa' }).click();
  await page.goto('/customers');
  await expect(page.getByText('David Chen').first()).toBeVisible();
  await expect(page.getByText('Lisa Park')).toHaveCount(0);
  await evidence(page, 'multi-location-west-isolated');

  await page.goBack();
  await page.goForward();
  await page.reload();
  await expect(page.getByText('David Chen').first()).toBeVisible();
  await expect(page.getByText('Lisa Park')).toHaveCount(0);
});
