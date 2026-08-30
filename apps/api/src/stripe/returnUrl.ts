/**
 * Checkout / Customer Portal 回跳地址。
 *
 * 客户端给的任意绝对 URL 是开放重定向：付款成功后地址栏上一跳是
 * stripe.com，下一跳却可以是仿冒登录页。只保留相对 path，域名一律用
 * `APP_BASE_URL`（默认 desk.geniefront.com，不是 .app）。
 */

export const DEFAULT_APP_BASE_URL = 'https://desk.geniefront.com';
export const DEFAULT_MARKETING_BASE_URL = 'https://www.geniefront.com';
export const DEFAULT_PORTAL_RETURN_PATH = '/settings?tab=billing';
export const SIGNUP_SUCCESS_PATH = '/signup/success?session_id={CHECKOUT_SESSION_ID}';
export const SIGNUP_CANCEL_PATH = '/signup/cancel';

export function appBaseUrl(): string {
  return (process.env['APP_BASE_URL'] ?? DEFAULT_APP_BASE_URL).replace(/\/+$/, '');
}

/** Public marketing origin. Never taken from request input. */
export function marketingBaseUrl(): string {
  return (process.env['MARKETING_BASE_URL'] ?? DEFAULT_MARKETING_BASE_URL).replace(/\/+$/, '');
}

export function signupReturnUrls(): { successUrl: string; cancelUrl: string } {
  const base = marketingBaseUrl();
  return {
    successUrl: `${base}${SIGNUP_SUCCESS_PATH}`,
    cancelUrl: `${base}${SIGNUP_CANCEL_PATH}`,
  };
}

/** 只认站内相对路径。协议、协议相对、或带 host 的一律丢掉。 */
export function safeRelativePath(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  const trimmed = value.trim();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) return fallback;
  if (trimmed.includes('://') || trimmed.includes('\\')) return fallback;
  return trimmed;
}

export function absoluteAppUrl(path: string): string {
  return `${appBaseUrl()}${path}`;
}

export function safeReturnUrls(body: { successUrl?: string; cancelUrl?: string } | undefined): {
  successUrl: string; cancelUrl: string;
} {
  return {
    successUrl: absoluteAppUrl(safeRelativePath(body?.successUrl, '/?billing=done')),
    cancelUrl: absoluteAppUrl(safeRelativePath(body?.cancelUrl, '/?billing=cancelled')),
  };
}

export function safePortalReturnUrl(returnUrl?: string): string {
  return absoluteAppUrl(safeRelativePath(returnUrl, DEFAULT_PORTAL_RETURN_PATH));
}
