/**
 * AUD-13 · Desk 的「今天 / 昨天」= 门店营业日（含 business_day_cutoff）
 *
 * ## 为什么原来的时区用例抓不到这个
 *
 * QA-008 的两条 clock 用例把时钟停在 `2026-08-31T00:15Z`，
 * 也就是纽约 **20:15** —— 那一刻早就过了 04:00 的 cutoff，
 * 于是「门店时区的日历日」和「营业日」恰好相等，两种实现都对。
 *
 * 真正会错的窗口是**当地午夜到 cutoff 之间的那几个小时**，
 * 而那正是前台打烊封账的时刻。下面的用例把时钟停在窗口里面。
 *
 * 判据统一：营业日 ≠ 门店时区的日历日，且每一块屏幕都取营业日那一个。
 */

import { expect, test } from '@playwright/test';
import { seedScenario, qaEmail } from '../seed';
import { chooseLocation, loginDesk } from '../helpers';

/** 门店时区下的**日历**日期。用来证明营业日确实和它不同。 */
function wallDate(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Day Close 页头显示的那个日期。 */
async function dayCloseDate(page: import('@playwright/test').Page): Promise<string | null> {
  return page.locator('span').filter({ hasText: /^20\d{2}-\d{2}-\d{2}$/ }).first().textContent();
}

test.describe('AUD-13 · business day honours the cutoff', () => {
  test('New York before the 04:00 cutoff: every surface stays on the previous business day', async ({ page }) => {
    // 2026-08-31 01:30 EDT —— 打烊后，日历已经翻页，营业日没有
    const frozen = '2026-08-31T05:30:00.000Z';
    const shopZone = 'America/New_York';

    await seedScenario('growth_active');
    await page.clock.install({ time: new Date(frozen) });
    await page.clock.resume();
    await loginDesk(page, qaEmail('growth_active'), '/dashboard');

    // 前提：这一刻门店时区的日历日已经是 08-31，而营业日应当仍是 08-30。
    // 两者相等的话这条用例什么都没测到。
    expect(wallDate(frozen, shopZone)).toBe('2026-08-31');

    await page.goto('/rotation');
    await expect(page.locator('input[type="date"]')).toHaveValue('2026-08-30');

    await page.goto('/schedule');
    await expect(page.locator('input[type="date"]')).toHaveValue('2026-08-30');
    // 点一次 Today 之后仍然是营业日（QA-008 修的是这个按钮的时区，不是 cutoff）
    await page.getByRole('button', { name: /^(Today|今天)$/ }).click();
    await expect(page.locator('input[type="date"]')).toHaveValue('2026-08-30');

    await page.goto('/day-close');
    await expect.poll(() => dayCloseDate(page)).toBe('2026-08-30');

    await page.getByRole('button', { name: /Yesterday|昨日/ }).click();
    await expect.poll(() => dayCloseDate(page)).toBe('2026-08-29');

    await page.getByRole('button', { name: /^(Today|今日)$/ }).click();
    await expect.poll(() => dayCloseDate(page)).toBe('2026-08-30');
  });

  test('New York after the cutoff: business day equals the calendar day', async ({ page }) => {
    // 2026-08-31 10:00 EDT —— 正常营业时间
    const frozen = '2026-08-31T14:00:00.000Z';

    await seedScenario('growth_active');
    await page.clock.install({ time: new Date(frozen) });
    await page.clock.resume();
    await loginDesk(page, qaEmail('growth_active'), '/rotation');

    await expect(page.locator('input[type="date"]')).toHaveValue('2026-08-31');

    await page.goto('/schedule');
    await expect(page.locator('input[type="date"]')).toHaveValue('2026-08-31');

    await page.goto('/day-close');
    await expect.poll(() => dayCloseDate(page)).toBe('2026-08-31');
    await page.getByRole('button', { name: /Yesterday|昨日/ }).click();
    await expect.poll(() => dayCloseDate(page)).toBe('2026-08-30');
  });

  test('Los Angeles before its own 03:00 cutoff, with the browser in New York', async ({ page }) => {
    /*
     * 2026-08-31T09:30Z = 洛杉矶 02:30 PDT（未过 03:00 cutoff）
     *                   = 纽约   05:30 EDT（已过 04:00 cutoff）
     *
     * 两件事同时要成立：
     *   · 判据用的是**门店**时区和**门店**的 cutoff，不是浏览器的
     *     （Playwright 的 timezoneId 是 America/New_York）
     *   · West 店的 cutoff 是 03:00，不是 East 店的 04:00 —— 每家店各算各的
     */
    const frozen = '2026-08-31T09:30:00.000Z';

    await seedScenario('multi_location_owner');
    await page.clock.install({ time: new Date(frozen) });
    await page.clock.resume();
    await loginDesk(page, qaEmail('multi_location_owner'), '/dashboard');
    await chooseLocation(page, 'West Side Spa');

    // 洛杉矶的日历日此刻已经是 08-31，营业日应当仍是 08-30
    expect(wallDate(frozen, 'America/Los_Angeles')).toBe('2026-08-31');

    await page.goto('/rotation');
    await expect(page.locator('input[type="date"]')).toHaveValue('2026-08-30');

    await page.goto('/schedule');
    await expect(page.locator('input[type="date"]')).toHaveValue('2026-08-30');
  });
});
