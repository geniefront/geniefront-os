import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_APP_BASE_URL,
  DEFAULT_MARKETING_BASE_URL,
  DEFAULT_PORTAL_RETURN_PATH,
  marketingBaseUrl,
  safePortalReturnUrl,
  safeRelativePath,
  safeReturnUrls,
  signupReturnUrls,
} from './returnUrl';

describe('portal / checkout 回跳地址', () => {
  const originalBase = process.env['APP_BASE_URL'];
  const originalMarketing = process.env['MARKETING_BASE_URL'];

  afterEach(() => {
    if (originalBase === undefined) delete process.env['APP_BASE_URL'];
    else process.env['APP_BASE_URL'] = originalBase;
    if (originalMarketing === undefined) delete process.env['MARKETING_BASE_URL'];
    else process.env['MARKETING_BASE_URL'] = originalMarketing;
  });

  it('合法的 /settings?tab=billing 相对路径接到 APP_BASE_URL', () => {
    process.env['APP_BASE_URL'] = 'https://desk.geniefront.com';
    expect(safePortalReturnUrl('/settings?tab=billing'))
      .toBe('https://desk.geniefront.com/settings?tab=billing');
  });

  it('缺省 path 也落在设置页账单 tab，而不是 .app/subscription', () => {
    delete process.env['APP_BASE_URL'];
    expect(safePortalReturnUrl(undefined))
      .toBe(`${DEFAULT_APP_BASE_URL}${DEFAULT_PORTAL_RETURN_PATH}`);
    expect(safePortalReturnUrl(undefined)).not.toContain('geniefront.app');
  });

  it('任意外部 origin 不能成为 return_url', () => {
    process.env['APP_BASE_URL'] = 'https://desk.geniefront.com';
    expect(safePortalReturnUrl('https://evil.example/phish'))
      .toBe('https://desk.geniefront.com/settings?tab=billing');
    expect(safePortalReturnUrl('http://evil.example'))
      .toBe('https://desk.geniefront.com/settings?tab=billing');
    expect(safePortalReturnUrl('//evil.example/x'))
      .toBe('https://desk.geniefront.com/settings?tab=billing');
    expect(safePortalReturnUrl('https://desk.geniefront.com.evil.example/'))
      .toBe('https://desk.geniefront.com/settings?tab=billing');
  });

  it('Checkout 的 success/cancel 走同一条相对路径规则', () => {
    process.env['APP_BASE_URL'] = 'https://desk.geniefront.com/';
    expect(safeReturnUrls({
      successUrl: 'https://evil.example/ok',
      cancelUrl: '/settings?tab=billing',
    })).toEqual({
      successUrl: 'https://desk.geniefront.com/?billing=done',
      cancelUrl: 'https://desk.geniefront.com/settings?tab=billing',
    });
  });

  it('safeRelativePath 丢掉协议相对与带 host 的值', () => {
    expect(safeRelativePath('https://evil.example', '/fallback')).toBe('/fallback');
    expect(safeRelativePath('//cdn.example/x', '/fallback')).toBe('/fallback');
    expect(safeRelativePath('/ok', '/fallback')).toBe('/ok');
  });

  it('marketing 回跳用 MARKETING_BASE_URL，默认 www.geniefront.com 而不是 .app', () => {
    delete process.env['MARKETING_BASE_URL'];
    expect(marketingBaseUrl()).toBe(DEFAULT_MARKETING_BASE_URL);
    expect(signupReturnUrls()).toEqual({
      successUrl: 'https://www.geniefront.com/signup/success?session_id={CHECKOUT_SESSION_ID}',
      cancelUrl: 'https://www.geniefront.com/signup/cancel',
    });
    expect(signupReturnUrls().successUrl).not.toContain('geniefront.app');
    expect(signupReturnUrls().cancelUrl).not.toContain('desk.geniefront.com');
  });

  it('marketing 回跳不接受请求里的绝对 URL —— 只认服务端配置', () => {
    process.env['MARKETING_BASE_URL'] = 'https://www.geniefront.com/';
    expect(signupReturnUrls().successUrl.startsWith('https://www.geniefront.com/')).toBe(true);
  });
});
