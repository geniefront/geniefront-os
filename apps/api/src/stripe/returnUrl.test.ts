import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_APP_BASE_URL,
  DEFAULT_PORTAL_RETURN_PATH,
  safePortalReturnUrl,
  safeRelativePath,
  safeReturnUrls,
} from './returnUrl';

describe('portal / checkout 回跳地址', () => {
  const originalBase = process.env['APP_BASE_URL'];

  afterEach(() => {
    if (originalBase === undefined) delete process.env['APP_BASE_URL'];
    else process.env['APP_BASE_URL'] = originalBase;
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
});
