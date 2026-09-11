// Frontend-only smoke check: run Web Vite on 5187 and Kiosk Vite on 5188.
// The session is mocked in this browser only; no backend data is read or changed.
import { chromium, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
const output = new URL('../artifacts/ipad-review/', import.meta.url).pathname;
await mkdir(output, { recursive: true });
/*
 * 文本裁切探测。字号抬高之后最典型的回归是「容器高度按桌面字号掐死 → 平板上
 * 把字母上下缘切掉」，横向溢出检查抓不到这一类，因此单独测量：凡是设了
 * overflow hidden 且没有声明单行省略号（那是刻意的截断）的元素，内容高度
 * 不得超过可视高度。阈值 2px 用于容忍子像素取整。
 */
const CLIPPING_PROBE = `Array.from(document.querySelectorAll('body *')).filter(el => {
  const style = getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  if (!['hidden', 'clip'].includes(style.overflowY)) return false;
  if (style.textOverflow === 'ellipsis' && style.whiteSpace === 'nowrap') return false;
  if (style.webkitLineClamp && style.webkitLineClamp !== 'none') return false;
  return el.scrollHeight - el.clientHeight > 2 && el.clientHeight > 0;
}).slice(0, 8).map(el => el.className + ' +' + (el.scrollHeight - el.clientHeight) + 'px')`;

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
    const clipped = await page.evaluate(CLIPPING_PROBE);
    expect(clipped, `desk ${width}px text clipping`).toEqual([]);
    await page.screenshot({path: `${output}desk-${width}.png`});
    console.log(`PASS desk navigation / overflow / clipping ${width}×${height}`);
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
    const kioskClipped = await page.evaluate(CLIPPING_PROBE);
    expect(kioskClipped, `kiosk ${width}px text clipping`).toEqual([]);
    await page.screenshot({path:`${output}kiosk-${width}.png`});
    console.log(`PASS kiosk pairing / overflow ${width}×${height}`);
  }
} finally { await browser.close(); }
