/**
 * 对外链接的唯一构造出处。
 *
 * ## 为什么必须集中
 *
 * 邮件与短信中的每一个链接都会离开本系统，落在客户或店主的设备上，
 * 且**无法撤回**。此前各调用点自行拼接 `process.env['APP_BASE_URL'] ??
 * 'https://desk.geniefront.com'`，由此产生两类缺陷：
 *
 *   1. **跨环境泄漏。** 兜底值是生产域名，因此 local 与 staging 一旦
 *      遗漏该环境变量，发出的邮件即指向生产站点。此类缺陷不会报错，
 *      只会在测试人员点击链接进入生产环境时才被发现。
 *   2. **路径与前端路由不一致。** 例如计费邮件此前指向 `/?tab=billing`，
 *      而实际路由为 `/settings?tab=billing`；根路径会重定向至
 *      `/dashboard` 并丢弃 query，按钮实际不可用。
 *
 * 因此：**禁止在业务代码中手动拼接对外链接**，一律调用本模块的具名函数。
 * 新增链接时在此处补一个函数，同时补一条断言其与前端路由一致的测试。
 *
 * ## 环境判定
 *
 * 权威为 `GF_ENV`（与 `comms/mode.ts` 一致）。兜底值**按环境分别给出** ——
 * 环境变量缺失时退回该环境自身的默认域名，而非生产域名，从根本上消除
 * 上述第 1 类缺陷。
 */

import { isProductionEnv } from './comms/mode';

export type GfEnv = 'local' | 'staging' | 'production';

type Env = Record<string, string | undefined>;

export function gfEnv(env: Env = process.env): GfEnv {
  const v = env['GF_ENV'];
  if (v === 'local' || v === 'staging' || v === 'production') return v;
  /*
   * ⚠️ GF_ENV 缺失时沿用 comms/mode.ts 的判定：NODE_ENV=production 视为生产。
   * 测试进程（NODE_ENV=test）落入 local，因此单元测试不会构造出生产链接。
   */
  return isProductionEnv(env) ? 'production' : 'local';
}

/** 四类对外站点。命名与 `.env.*` 中的变量一一对应。 */
type Site = 'app' | 'marketing' | 'form' | 'booking';

/**
 * 各环境的兜底 origin，取自 `.env.local.example` / `.env.staging.example` /
 * `.env.production.example`。修改这三份文件时必须同步此表。
 */
const FALLBACK: Record<GfEnv, Record<Site, string>> = {
  local: {
    app: 'http://127.0.0.1:5177',
    marketing: 'http://127.0.0.1:5175',
    form: 'http://127.0.0.1:5177',
    booking: 'http://127.0.0.1:5177',
  },
  staging: {
    app: 'https://staging-desk.geniefront.com',
    marketing: 'https://staging.geniefront.com',
    form: 'https://staging-desk.geniefront.com',
    booking: 'https://staging-book.geniefront.com',
  },
  production: {
    app: 'https://desk.geniefront.com',
    marketing: 'https://www.geniefront.com',
    form: 'https://desk.geniefront.com',
    booking: 'https://book.geniefront.com',
  },
};

/**
 * 生产环境的默认 origin。仅供测试与文档引用；业务代码一律调用下方的
 * 具名函数，以免绕过按环境分流的兜底逻辑。
 */
export const DEFAULT_APP_BASE_URL = FALLBACK.production.app;
export const DEFAULT_MARKETING_BASE_URL = FALLBACK.production.marketing;
export const DEFAULT_BOOKING_PAGE_ORIGIN = FALLBACK.production.booking;

/** `APP_URL` 缺失时的兜底，取自 `.env.*.example`。 */
const API_FALLBACK: Record<GfEnv, string> = {
  local: 'http://127.0.0.1:3000',
  staging: 'https://staging-api.geniefront.com',
  production: 'https://api.geniefront.com',
};

const ENV_KEY: Record<Site, string> = {
  app: 'APP_BASE_URL',
  marketing: 'MARKETING_BASE_URL',
  form: 'FORM_BASE_URL',
  booking: 'BOOKING_PAGE_ORIGIN',
};

function isLoopbackHost(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
}

/**
 * staging / production 发出去的链接无法撤回。本机地址一旦写进邮件，
 * 客人点开打到的是**他自己的电脑**，表现为「链接坏了」，而发信一侧
 * 没有任何报错。local 允许 loopback；其余环境必须是 https 公网 origin。
 */
function assertPublicOrigin(url: string, env: Env, what: string): string {
  if (gfEnv(env) === 'local') return url;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${what} 不是合法 URL：${url}`);
  }
  if (isLoopbackHost(parsed.hostname)) {
    throw new Error(
      `${what} 在 GF_ENV=${gfEnv(env)} 下不能是本机地址（${url}）。`
      + 'staging/production 的邮件无法撤回，点开等于打到客人自己的电脑。',
    );
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`${what} 在 GF_ENV=${gfEnv(env)} 下必须是 https（${url}）`);
  }
  return url;
}

/** 去掉末尾斜杠。`BOOKING_PAGE_ORIGIN` 允许逗号分隔多值，构造链接时取第一个。 */
function originOf(site: Site, env: Env = process.env): string {
  const raw = env[ENV_KEY[site]];
  const first = raw?.split(',')[0]?.trim();
  const base = (first && first.length > 0 ? first : FALLBACK[gfEnv(env)][site]).replace(/\/+$/, '');
  return assertPublicOrigin(base, env, ENV_KEY[site]);
}

// ─────────────────────────────────────────────────────────────── origin

/** 员工工作台（apps/web）。 */
export function appBaseUrl(env: Env = process.env): string {
  return originOf('app', env);
}

/** 公开营销站（apps/marketing）。绝不接受请求入参。 */
export function marketingBaseUrl(env: Env = process.env): string {
  return originOf('marketing', env);
}

/** 顾客填表页所在站点。当前与工作台同源，保留独立变量以便日后拆分。 */
export function formBaseUrl(env: Env = process.env): string {
  return originOf('form', env);
}

/**
 * 本 API 自身的对外 origin（`APP_URL`）。
 *
 * 仅用于必须由**服务端**直接受理的链接 —— 目前只有 RFC 8058 的一键退订
 * （`List-Unsubscribe` 头指向的地址必须接受 POST，前端 SPA 承载不了）。
 */
export function apiBaseUrl(env: Env = process.env): string {
  const raw = env['APP_URL'];
  const base = (raw && raw.length > 0 ? raw : API_FALLBACK[gfEnv(env)]).replace(/\/+$/, '');
  return assertPublicOrigin(base, env, 'APP_URL');
}

/**
 * 启动闸门：把所有会写进邮件的 origin 先算一遍。
 *
 * 算的过程会走 `assertPublicOrigin`。配错时进程起不来，而不是等第一封
 * 确认信带着 `http://127.0.0.1` 发出去之后才被客人发现。
 */
export function assertOutboundLinkSafety(env: Env = process.env): void {
  if (gfEnv(env) === 'local') return;
  appBaseUrl(env);
  marketingBaseUrl(env);
  formBaseUrl(env);
  bookingPageOrigin(env);
  apiBaseUrl(env);
}

/** 门店对外预约页。生产环境为独立域名 book.geniefront.com。 */
export function bookingPageOrigin(env: Env = process.env): string {
  return originOf('booking', env);
}

// ─────────────────────────────────────────────────── 前端路由（唯一事实源）

/**
 * ⭐ 以下常量必须与 `apps/web/src/App.tsx` 的路由表保持一致。
 * 任一路径变更时，`links.test.ts` 中的对照断言会失败。
 */
export const PATHS = {
  /** 计费设置。注意是 `/settings?tab=billing`，根路径会重定向并丢弃 query */
  billing: '/settings?tab=billing',
  activate: '/activate',
  resetPassword: '/reset-password',
  /** 顾客填表页。`intake` 为稳定占位段，实际权限完全由一次性令牌决定 */
  formIntake: '/forms/intake',
  /** 顾客自助改期 / 取消页，由对外预约页承载 */
  manageBooking: '/b',
  /**
   * Canonical hosted manage path: /l/{slug}#g/{token}.
   * The token stays in the fragment so Caddy, Cloudflare, and access logs
   * never see it on the request line.
   */
  hostedManageBooking: '/l',
  /** 营销邮件退订页，由对外预约页承载（无需登录） */
  emailUnsubscribe: '/unsubscribe',
  /**
   * 邮件抬头 logo。PNG 而不是 SVG：Outlook 等客户端不渲染 SVG。
   * 文件在 `apps/marketing/public/brand/geniefront-logo-email.png`。
   */
  emailLogo: '/brand/geniefront-logo-email.png',
} as const;

/** 邮件 HTML 里 logo 的绝对地址。走营销站 origin，按环境分流。 */
export function emailLogoUrl(env: Env = process.env): string {
  return `${marketingBaseUrl(env)}${PATHS.emailLogo}`;
}

// ────────────────────────────────────────────────────────────── 具名链接

/** 店主自助管理订阅的入口。计费类邮件中唯一的可点动作。 */
export function billingPortalUrl(env: Env = process.env): string {
  return `${appBaseUrl(env)}${PATHS.billing}`;
}

/** 激活链接落点。域名一律取自配置，不接受任何外部输入。 */
export function activationRedirectUrl(env: Env = process.env): string {
  return `${appBaseUrl(env)}${PATHS.activate}`;
}

/** 重置密码落点。约束同上。 */
export function resetRedirectUrl(env: Env = process.env): string {
  return `${appBaseUrl(env)}${PATHS.resetPassword}`;
}

/** 顾客填表链接。令牌走 query，与自助取消、门店官网的形状保持一致。 */
export function formIntakeUrl(token: string, env: Env = process.env): string {
  return `${formBaseUrl(env)}${PATHS.formIntake}?t=${encodeURIComponent(token)}`;
}

/**
 * 对外预约页是否已经承载自助改期 / 取消页（`/b/:id`）。
 *
 * ## ⚠️ 默认关闭，这是有意的
 *
 * 自助改期的**后端**在批 2 就做完了（`POST /public/v1/bookings/:id/reschedule`
 * 与 `/cancel`，docs/13 §4.6），但承载它的**前端页面尚未上线** ——
 * 本仓库的 `apps/web` 路由表里没有 `/b/:id`。
 *
 * 在此之前把链接放进确认信，结果是顾客点开之后落到一个陌生页面，
 * 而他此刻正想改期。**一个失效的按钮比没有按钮更糟**：没有按钮时模板会
 * 引导他打电话，而门店此时还有挽留的机会。
 *
 * 因此该链接由环境变量显式启用：页面上线后在对应环境置
 * `BOOKING_MANAGE_PAGE_ENABLED=1`，无需改代码。
 */
export function bookingManagePageEnabled(env: Env = process.env): boolean {
  return env['BOOKING_MANAGE_PAGE_ENABLED'] === '1';
}

/**
 * 顾客自助改期 / 取消链接。**页面未上线时返回 null。**
 *
 * ⚠️ **必须携带 `k`（门店 public_key）。** 该页面调用的是公开预约 API，
 * 每一次请求都要求 `X-GF-Public-Key` 头；缺少该参数时页面无法完成任何
 * 请求，链接虽可打开但功能不可用。
 *
 * ⚠️ origin 取 `BOOKING_PAGE_ORIGIN` 而非 `APP_BASE_URL`：后者是员工
 * 工作台，顾客访问将落到登录页。
 *
 * 令牌本身不足以构成授权 —— 页面打开后仍需校验手机号后四位
 * （`public/routes.ts` 的 `assertLast4`）。
 */
export function manageBookingUrl(
  args: { appointmentId: string; manageToken: string; publicKey: string },
  env: Env = process.env,
): string | null {
  if (!bookingManagePageEnabled(env)) return null;
  const q = new URLSearchParams({ t: args.manageToken, k: args.publicKey });
  return `${bookingPageOrigin(env)}${PATHS.manageBooking}/${
    encodeURIComponent(args.appointmentId)}?${q.toString()}`;
}

/**
 * Canonical guest manage URL. Token is in the fragment (`#g/{token}`),
 * not the request path. Public key and appointment id are not included.
 * Still gated by BOOKING_MANAGE_PAGE_ENABLED.
 *
 * Fragments are not sent to the origin, so Caddy JSON access logs and
 * Cloudflare/Logpush request URIs cannot capture the raw token. The
 * booking app still accepts the older `/l/{slug}/g/{token}` path as a
 * client-side fallback; that path is never issued.
 */
export function hostedManageBookingUrl(
  args: { shopSlug: string; manageToken: string },
  env: Env = process.env,
): string | null {
  if (!bookingManagePageEnabled(env)) return null;
  return `${bookingPageOrigin(env)}${PATHS.hostedManageBooking}/${
    encodeURIComponent(args.shopSlug)}#g/${encodeURIComponent(args.manageToken)}`;
}

/**
 * 营销邮件退订页。
 *
 * 页面挂在 `apps/web` 的公开路由 `/unsubscribe`（登录门禁之前）。
 * origin 因此取 **desk**（`APP_BASE_URL`），不是 `BOOKING_PAGE_ORIGIN`：
 * 生产的 book.geniefront.com 当前不托管这份 SPA，链过去会 404。
 * 公开路由不要求登录，CAN-SPAM 的「不得设门槛」仍然满足。
 */
export function emailUnsubscribeUrl(token: string, env: Env = process.env): string {
  return `${appBaseUrl(env)}${PATHS.emailUnsubscribe}?t=${encodeURIComponent(token)}`;
}

/**
 * 一键退订端点（RFC 8058）。
 *
 * `List-Unsubscribe` 头指向的地址必须**接受 POST 且无需交互**，因此指向
 * API 自身而非前端页面。收件方（Gmail、Outlook）在用户点击其界面上的
 * 「取消订阅」时直接 POST 该地址。
 */
export function emailUnsubscribePostUrl(token: string, env: Env = process.env): string {
  return `${apiBaseUrl(env)}/public/v1/email/unsubscribe?t=${encodeURIComponent(token)}`;
}

// ─────────────────────────────────────────────────────── 回跳地址（Stripe）

export const DEFAULT_PORTAL_RETURN_PATH = PATHS.billing;
export const SIGNUP_SUCCESS_PATH = '/signup/success?session_id={CHECKOUT_SESSION_ID}';
export const SIGNUP_CANCEL_PATH = '/signup/cancel';

export function signupReturnUrls(env: Env = process.env): {
  successUrl: string; cancelUrl: string;
} {
  const base = marketingBaseUrl(env);
  return {
    successUrl: `${base}${SIGNUP_SUCCESS_PATH}`,
    cancelUrl: `${base}${SIGNUP_CANCEL_PATH}`,
  };
}

/**
 * 只接受站内相对路径。带协议、协议相对或带 host 的一律丢弃。
 *
 * 客户端提供的任意绝对 URL 构成开放重定向：付款完成后地址栏上一跳为
 * stripe.com，下一跳却可能是仿冒登录页。
 */
export function safeRelativePath(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  const trimmed = value.trim();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) return fallback;
  if (trimmed.includes('://') || trimmed.includes('\\')) return fallback;
  return trimmed;
}

export function absoluteAppUrl(path: string, env: Env = process.env): string {
  return `${appBaseUrl(env)}${path}`;
}

export function safeReturnUrls(
  body: { successUrl?: string; cancelUrl?: string } | undefined,
): { successUrl: string; cancelUrl: string } {
  return {
    successUrl: absoluteAppUrl(safeRelativePath(body?.successUrl, '/?billing=done')),
    cancelUrl: absoluteAppUrl(safeRelativePath(body?.cancelUrl, '/?billing=cancelled')),
  };
}

export function safePortalReturnUrl(returnUrl?: string): string {
  return absoluteAppUrl(safeRelativePath(returnUrl, DEFAULT_PORTAL_RETURN_PATH));
}

/** Staff-only appointment detail; the desk enforces its authenticated tenant. */
export function staffAppointmentUrl(appointmentId: string, locationId: string, env: Env = process.env): string {
  return absoluteAppUrl(`/schedule?appointmentId=${encodeURIComponent(appointmentId)}&locationId=${encodeURIComponent(locationId)}`,env);
}

/** Short staff-only identifier. The destination still requires a logged-in tenant membership. */
export function staffBookingShortUrl(code:string,env:Env=process.env):string {
 if(!/^[a-f0-9]{16}$/.test(code))throw new Error('Invalid staff booking code');
 return absoluteAppUrl(`/b/${code}`,env);
}

export function smsDeliveryWebhookUrl(env: Env = process.env): string {
  return `${apiBaseUrl(env)}/v1/telnyx/webhook`;
}
