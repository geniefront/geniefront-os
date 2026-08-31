import { expect, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { QA_PASSWORD } from './seed';
import { rootDir } from './env';

export async function preferEnglish(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem('gf.lang', 'en'));
}

export async function loginDesk(page: Page, email: string, path = '/dashboard'): Promise<void> {
  await preferEnglish(page);
  await page.goto(path);
  await page.locator('#login-email').fill(email);
  await page.locator('#login-password').fill(QA_PASSWORD);
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await expect(page.locator('#login-email')).toBeHidden({ timeout: 15_000 });
}

export async function loginPlatform(page: Page, email: string, password = QA_PASSWORD): Promise<void> {
  await page.goto('http://127.0.0.1:5179/');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Dashboard|Access denied/ })).toBeVisible({ timeout: 15_000 });
}

export async function chooseLocation(page: Page, name: string): Promise<void> {
  await page.getByRole('button').filter({ hasText: name }).click();
  await expect(page.getByRole('complementary').getByText(name, { exact: true })).toBeVisible();
}

export async function evidence(page: Page, name: string): Promise<void> {
  const dir = path.join(rootDir, 'artifacts/playwright/evidence');
  await fs.mkdir(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${name}.png`), fullPage: true });
}
