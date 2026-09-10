// Frontend-only smoke check: run Web Vite on 5187 and Kiosk Vite on 5188.
// The session is mocked in this browser only; no backend data is read or changed.
import { chromium, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
const output = new URL('../artifacts/ipad-review/', import.meta.url).pathname;
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ hasTouch: true, deviceScaleFactor: 2 });
  await page.route('**/src/lib/session.tsx*', route => route.fulfill({
    contentType: 'application/javascript',
    body: `const noop = () => {};
      const value = { status: 'ready', activePortal: 'admin', isOnline: true,
        isTechCapable: false, isPureTech: false, locations: [],
        membership: { locationName: { en: 'Tablet review', 'zh-Hans': '平板审查门店' }, roleKeys: ['owner'], status: 'active' },
        context: { timezone: 'America/New_York', businessDayCutoff: '00:00', permissions: [] },
        session: { user: { email: 'tablet@example.invalid' } },
        can: () => true, clearMembership: noop, signOut: noop, switchPortal: noop };
      export const useSession = () => value;
      export const SessionProvider = ({children}) => children;`,
  }));
  await page.route('**/v1/**', route => route.abort());
  for (const [width, height] of [[600,900], [768,1024], [820,1180], [1024,768], [1180,820], [1366,1024]]) {
    await page.setViewportSize({ width, height });
    await page.goto('http://127.0.0.1:5187/notifications');
    const nav = page.locator('#desk-navigation');
    await expect(nav).toBeAttached();
    if (width < 1280) {
      await expect(nav).toHaveAttribute('inert', '');
      await page.getByRole('button', { name: /Open navigation|打开导航/ }).click();
      await expect(nav).not.toHaveAttribute('inert');
      await expect(nav.getByRole('link').first()).toBeVisible();
      const target = await nav.getByRole('link').first().boundingBox();
      expect(target.height).toBeGreaterThanOrEqual(44);
      await page.keyboard.press('Escape');
      await expect(nav).toHaveAttribute('inert', '');
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({path: `${output}desk-${width}.png`});
    console.log(`PASS desk navigation / overflow ${width}×${height}`);
  }
  // A collapsed desktop sidebar must regain labels when opened after rotation.
  await page.getByRole('button', {name: /Collapse sidebar|收起侧边栏/}).click();
  await page.setViewportSize({width:820,height:1180});
  await page.getByRole('button', {name: /Open navigation|打开导航/}).click();
  await expect(page.locator('#desk-navigation a span').first()).toBeVisible();
  console.log('PASS collapsed desktop → portrait navigation labels');
  for (const [width,height] of [[600,900],[768,1024],[820,1180],[1024,768],[1180,820],[1366,1024]]) {
    await page.setViewportSize({width,height});
    await page.goto('http://127.0.0.1:5188/pair');
    await expect(page.locator('input').first()).toBeAttached();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    expect(await page.locator('meta[name="viewport"]').getAttribute('content')).not.toContain('user-scalable=no');
    await page.screenshot({path:`${output}kiosk-${width}.png`});
    console.log(`PASS kiosk pairing / overflow ${width}×${height}`);
  }
} finally { await browser.close(); }
