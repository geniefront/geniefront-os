/**
 * 官网域名白名单（docs/13 §3）。
 *
 * ⚠️ **这不是鉴权。** 浏览器才发 `Origin`，curl 不发也可以随便伪造。
 * 它挡的是「别人的网站嵌一个我们的预约表单」这一类事，
 * 挡不住任何一个愿意写脚本的人 —— 那个由 Turnstile + 限频 + 蜜罐挡。
 *
 * 它真正的价值：把一个**公开** key 的使用面收回到老板自己的站点上。
 */

/**
 * 规范化成 `协议://主机[:端口]`。
 *
 * 老板会粘各种东西进来：`lotusnails.com`、`www.lotusnails.com/`、
 * `https://lotusnails.com/booking?x=1`。让他自己弄对是不现实的
 * （`04` §2：能给默认值就别让他填），所以这里全部收敛掉。
 *
 * 没有协议时补 `https://` —— 2026 年还在用 http 的门店官网不该被我们鼓励。
 */
export function normalizeOrigin(raw: string): string | null {
  const v = raw.trim().toLowerCase();
  if (!v) return null;
  const withScheme = /^https?:\/\//.test(v) ? v : `https://${v}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (!u.hostname) return null;
  // localhost 之外不许用 http：白名单里混一条 http 的，
  // 等于给中间人一条能改预约表单的路
  if (u.protocol === 'http:' && !/^(localhost|127\.0\.0\.1)$/.test(u.hostname)) return null;

  const port = u.port ? `:${u.port}` : '';
  return `${u.protocol}//${u.hostname}${port}`;
}

/**
 * 白名单匹配。支持 `https://*.pages.dev` 这种一层通配 ——
 * Cloudflare Pages / Vercel 的预览域名每次部署都变，
 * 不支持通配的话老板每改一次官网就要回来加一条。
 *
 * ⚠️ 通配只吃**一层**子域：`*.pages.dev` 匹配 `abc.pages.dev`，
 * 不匹配 `evil.abc.pages.dev`，更不匹配 `pages.dev` 本身。
 */
export function originAllowed(origin: string | undefined, allowed: readonly string[]): boolean {
  if (!origin) return false;
  const got = normalizeOrigin(origin);
  if (!got) return false;

  return allowed.some((entry) => {
    const pattern = entry.trim().toLowerCase();
    if (pattern === got) return true;
    if (!pattern.includes('*')) return false;

    const [scheme, rest] = pattern.split('://') as [string, string | undefined];
    if (!rest?.startsWith('*.')) return false;
    const suffix = rest.slice(2);
    const [gotScheme, gotRest] = got.split('://') as [string, string | undefined];
    if (scheme !== gotScheme || !gotRest) return false;
    if (!gotRest.endsWith(`.${suffix}`)) return false;
    // 只吃一层：去掉后缀之后不能再有点
    return !gotRest.slice(0, gotRest.length - suffix.length - 1).includes('.');
  });
}

/**
 * ⭐ 我们自己托管的那张预约页（`apps/booking`）永远放行。
 *
 * 为什么必须有这一条：那张页面**跑在我们的域名下**，无论它是被
 * 直接打开的，还是被嵌进老板官网的 iframe 里 —— iframe 里的文档
 * origin 是 `book.geniefront.com`，不是 `lotusnails.com`。
 *
 * 没有这一条的话，每个老板都得先把**我们的**域名填进他自己的白名单，
 * 才能用我们给他的页面。那是一条纯粹的自伤：忘了填的表现是
 * 「上线当天整页 403」，而他根本想不到要去填别人的域名。
 *
 * ⚠️ 这不放宽任何东西。白名单从来就不是鉴权（见文件头）——
 * 任何人都能直接打开 `book.geniefront.com/?k=<任意 key>`，
 * 因为那串 key 本来就是公开的。真正挡机器人的是 Turnstile + 限频 + 蜜罐。
 */
export function isHostedBookingOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  const got = normalizeOrigin(origin);
  if (!got) return false;

  const configured = (process.env['BOOKING_PAGE_ORIGIN'] ?? 'https://book.geniefront.com')
    .split(',').map((v) => normalizeOrigin(v)).filter((v): v is string => !!v);

  if (configured.includes(got)) return true;
  // 本地开发：预约页起在 5176，但端口会变，所以整个 localhost 都认
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(got);
}
