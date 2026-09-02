import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_APP_BASE_URL,
  DEFAULT_BOOKING_PAGE_ORIGIN,
  DEFAULT_MARKETING_BASE_URL,
  DEFAULT_PORTAL_RETURN_PATH,
  PATHS,
  activationRedirectUrl,
  apiBaseUrl,
  appBaseUrl,
  assertOutboundLinkSafety,
  billingPortalUrl,
  bookingPageOrigin,
  emailLogoUrl,
  emailUnsubscribePostUrl,
  emailUnsubscribeUrl,
  formBaseUrl,
  formIntakeUrl,
  gfEnv,
  hostedManageBookingUrl,
  manageBookingUrl,
  marketingBaseUrl,
  resetRedirectUrl,
  safePortalReturnUrl,
  safeRelativePath,
  safeReturnUrls,
  signupReturnUrls,
} from './links';
import { renderConfirm, renderFormInvite, renderTrialEnding } from './email/render';
import { renderMarketingEmail } from './email/layout';

const KEYS = [
  'GF_ENV', 'APP_URL', 'APP_BASE_URL', 'MARKETING_BASE_URL', 'FORM_BASE_URL',
  'BOOKING_PAGE_ORIGIN', 'BOOKING_MANAGE_PAGE_ENABLED',
] as const;

const original = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

function setEnv(patch: Partial<Record<(typeof KEYS)[number], string>>): void {
  for (const k of KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(patch)) process.env[k] = v;
}

afterEach(() => {
  for (const k of KEYS) {
    const v = original[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('环境分流', () => {
  it('GF_ENV 缺失且非生产时按 local 处理', () => {
    setEnv({});
    expect(gfEnv()).toBe('local');
  });

  it('⭐ 环境变量缺失时兜底到本环境域名，绝不落到生产', () => {
    setEnv({ GF_ENV: 'staging' });
    expect(billingPortalUrl()).toBe('https://staging-desk.geniefront.com/settings?tab=billing');
    expect(billingPortalUrl()).not.toContain('//desk.geniefront.com');

    setEnv({ GF_ENV: 'local' });
    expect(billingPortalUrl()).toBe('http://127.0.0.1:5177/settings?tab=billing');
    expect(billingPortalUrl()).not.toContain('geniefront.com');
  });

  it('显式配置的环境变量优先于兜底值', () => {
    setEnv({ GF_ENV: 'staging', APP_BASE_URL: 'https://desk.example.test/' });
    expect(billingPortalUrl()).toBe('https://desk.example.test/settings?tab=billing');
  });

  it('BOOKING_PAGE_ORIGIN 允许逗号分隔多值，构造链接时取第一个', () => {
    setEnv({ BOOKING_PAGE_ORIGIN: 'https://book.a.test, https://book.b.test' });
    expect(bookingPageOrigin()).toBe('https://book.a.test');
  });
});

function hrefs(html: string): string[] {
  return [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!);
}

function expectNoLoopback(url: string): void {
  expect(url, url).not.toMatch(/127\.0\.0\.1|localhost|0\.0\.0\.0/i);
}

describe('邮件对外链接不得跨环境泄漏', () => {
  it('staging 缺省时每一条对外链接都落在 staging 域名，绝不是本机', () => {
    setEnv({ GF_ENV: 'staging' });
    const urls = [
      appBaseUrl(),
      marketingBaseUrl(),
      formBaseUrl(),
      bookingPageOrigin(),
      apiBaseUrl(),
      billingPortalUrl(),
      emailLogoUrl(),
      emailUnsubscribeUrl('tok_1'),
      emailUnsubscribePostUrl('tok_1'),
      formIntakeUrl('fs_abc'),
      activationRedirectUrl(),
      resetRedirectUrl(),
    ];
    for (const url of urls) {
      expectNoLoopback(url);
      expect(url.startsWith('https://'), url).toBe(true);
      expect(url, url).toContain('staging');
      expect(url, url).not.toContain('//desk.geniefront.com');
      expect(url, url).not.toContain('//api.geniefront.com');
      expect(url, url).not.toContain('//www.geniefront.com');
      expect(url, url).not.toContain('//book.geniefront.com');
    }
    expect(emailUnsubscribeUrl('tok_1')).toBe(
      'https://staging-desk.geniefront.com/unsubscribe?t=tok_1',
    );
    expect(emailUnsubscribePostUrl('tok_1')).toBe(
      'https://staging-api.geniefront.com/public/v1/email/unsubscribe?t=tok_1',
    );
    expect(emailLogoUrl()).toBe(
      'https://staging.geniefront.com/brand/geniefront-logo-email.png',
    );
    expect(billingPortalUrl()).toBe(
      'https://staging-desk.geniefront.com/settings?tab=billing',
    );
    expect(formIntakeUrl('fs_abc')).toBe(
      'https://staging-desk.geniefront.com/forms/intake?t=fs_abc',
    );
  });

  it('staging 打开自助改期页时，链接也在 staging-desk，不带本机', () => {
    setEnv({ GF_ENV: 'staging', BOOKING_MANAGE_PAGE_ENABLED: '1' });
    const url = manageBookingUrl({
      appointmentId: 'a1', manageToken: 'mt_x', publicKey: 'pk_1',
    });
    expect(url).toBe('https://staging-desk.geniefront.com/b/a1?t=mt_x&k=pk_1');
    expectNoLoopback(url!);
  });

  it('staging 配了 localhost 的营销域 / 退订域 / API，构造时直接抛', () => {
    setEnv({ GF_ENV: 'staging', MARKETING_BASE_URL: 'http://127.0.0.1:5175' });
    expect(() => marketingBaseUrl()).toThrow(/本机/);
    expect(() => emailLogoUrl()).toThrow(/本机/);

    setEnv({ GF_ENV: 'staging', APP_BASE_URL: 'http://localhost:5177' });
    expect(() => emailUnsubscribeUrl('t')).toThrow(/本机/);

    setEnv({ GF_ENV: 'staging', BOOKING_PAGE_ORIGIN: 'http://localhost:5177', BOOKING_MANAGE_PAGE_ENABLED: '1' });
    expect(() => manageBookingUrl({
      appointmentId: 'a1', manageToken: 'mt', publicKey: 'pk',
    })).toThrow(/本机/);

    setEnv({ GF_ENV: 'staging', APP_URL: 'http://127.0.0.1:3000' });
    expect(() => emailUnsubscribePostUrl('t')).toThrow(/本机/);

    setEnv({ GF_ENV: 'staging', FORM_BASE_URL: 'http://127.0.0.1:5177' });
    expect(() => formIntakeUrl('fs_x')).toThrow(/本机/);
  });

  it('assertOutboundLinkSafety：staging 配了本机 origin 拒绝启动', () => {
    setEnv({ GF_ENV: 'staging' });
    expect(() => assertOutboundLinkSafety()).not.toThrow();

    setEnv({ GF_ENV: 'staging', MARKETING_BASE_URL: 'http://127.0.0.1:5175' });
    expect(() => assertOutboundLinkSafety()).toThrow(/MARKETING_BASE_URL/);
  });

  it('production 缺省链接落在生产域名', () => {
    setEnv({ GF_ENV: 'production' });
    expect(emailUnsubscribeUrl('t')).toBe(`${DEFAULT_APP_BASE_URL}/unsubscribe?t=t`);
    expect(emailUnsubscribePostUrl('t')).toBe(
      'https://api.geniefront.com/public/v1/email/unsubscribe?t=t',
    );
    expect(emailLogoUrl()).toBe(`${DEFAULT_MARKETING_BASE_URL}${PATHS.emailLogo}`);
    expectNoLoopback(emailLogoUrl());
  });

  it('⭐ staging 渲染出来的每一封信，每一个 href 都不是本机', () => {
    setEnv({ GF_ENV: 'staging', BOOKING_MANAGE_PAGE_ENABLED: '1' });

    const confirm = renderConfirm({
      customerName: 'Jessica',
      shopName: 'Oasis Nails',
      serviceName: 'Gel Manicure',
      whenText: 'Wed, Aug 20, 2:30 PM',
      staffName: 'Kim',
      shopPhone: '+15125550100',
      manageUrl: manageBookingUrl({
        appointmentId: 'a1', manageToken: 'mt_x', publicKey: 'pk_1',
      }),
    });
    const confirmHrefs = hrefs(confirm.html);
    expect(confirmHrefs).toContain('https://staging.geniefront.com');
    expect(confirm.html).toContain('https://staging-desk.geniefront.com/b/a1?t=mt_x&amp;k=pk_1');
    expect(confirm.html).toContain('https://staging.geniefront.com/brand/geniefront-logo-email.png');

    const invite = renderFormInvite({
      customerName: 'Jessica',
      shopName: 'Oasis Nails',
      formTitles: ['Waiver'],
      url: formIntakeUrl('fs_abc'),
      expiresText: 'Wed, Aug 26, 10:00 AM',
      shopPhone: '+15125550100',
    });
    expect(hrefs(invite.html)).toContain(
      'https://staging-desk.geniefront.com/forms/intake?t=fs_abc',
    );

    const trial = renderTrialEnding({
      shopName: 'Oasis Nails',
      chargeDateText: 'Tue, Sep 1',
      planLabel: 'Essential',
      monthlyText: '$99/month',
      billingUrl: billingPortalUrl(),
      locale: 'en',
    });
    expect(hrefs(trial.html)).toContain(
      'https://staging-desk.geniefront.com/settings?tab=billing',
    );

    const unsub = emailUnsubscribeUrl('u_1');
    const marketing = renderMarketingEmail('Happy birthday', unsub);
    expect(hrefs(marketing.html)).toContain(
      'https://staging-desk.geniefront.com/unsubscribe?t=u_1',
    );
    expect(marketing.text).toContain('https://staging-desk.geniefront.com/unsubscribe?t=u_1');

    for (const html of [confirm.html, invite.html, trial.html, marketing.html]) {
      expectNoLoopback(html);
      for (const href of hrefs(html)) expectNoLoopback(href);
    }
  });
});

describe('具名链接与前端路由一致', () => {
  /**
   * ⭐ 这一组断言存在的意义：链接指向一个不存在的路由时不会报错，
   * 只会把收件人送到登录页或 dashboard，而发信一方无从察觉。
   */
  const here = dirname(fileURLToPath(import.meta.url));
  const appTsx = readFileSync(join(here, '../../web/src/App.tsx'), 'utf8');

  it('计费入口指向 /settings?tab=billing，而不是会丢弃 query 的根路径', () => {
    setEnv({ GF_ENV: 'production' });
    expect(billingPortalUrl()).toBe(`${DEFAULT_APP_BASE_URL}/settings?tab=billing`);
    expect(billingPortalUrl()).not.toBe(`${DEFAULT_APP_BASE_URL}/?tab=billing`);
    expect(appTsx).toContain('path="settings"');
  });

  it('激活与重置密码路径在 apps/web 路由表中存在', () => {
    setEnv({ GF_ENV: 'production' });
    expect(activationRedirectUrl()).toBe(`${DEFAULT_APP_BASE_URL}${PATHS.activate}`);
    expect(resetRedirectUrl()).toBe(`${DEFAULT_APP_BASE_URL}${PATHS.resetPassword}`);
    expect(appTsx).toContain(`path="${PATHS.activate}"`);
    expect(appTsx).toContain(`path="${PATHS.resetPassword}"`);
  });

  it('填表链接落在 /forms/:key 这条公开路由上', () => {
    setEnv({ GF_ENV: 'production' });
    expect(formIntakeUrl('fs_abc')).toBe(`${DEFAULT_APP_BASE_URL}/forms/intake?t=fs_abc`);
    expect(appTsx).toContain('path="/forms/:key"');
  });

  it('自助改期链接走对外预约页，并且必带 public_key', () => {
    setEnv({ GF_ENV: 'production', BOOKING_MANAGE_PAGE_ENABLED: '1' });
    const url = manageBookingUrl({
      appointmentId: 'a1', manageToken: 'mt_x', publicKey: 'pk_1234',
    });
    expect(url).toBe(`${DEFAULT_BOOKING_PAGE_ORIGIN}/b/a1?t=mt_x&k=pk_1234`);
    // 员工工作台不承载该页面：指过去只会落到登录页
    expect(url).not.toContain(DEFAULT_APP_BASE_URL);
  });

  it('canonical hosted manage URL has slug + token and no public key or appointment id', () => {
    setEnv({ GF_ENV: 'production', BOOKING_MANAGE_PAGE_ENABLED: '1' });
    const url = hostedManageBookingUrl({ shopSlug: 'lotus-nails', manageToken: 'mt_secret' });
    expect(url).toBe(`${DEFAULT_BOOKING_PAGE_ORIGIN}/l/lotus-nails/g/mt_secret`);
    expect(url).not.toContain('pk_');
    expect(url).not.toMatch(/\/b\//);
    expect(hostedManageBookingUrl(
      { shopSlug: 'lotus-nails', manageToken: 'mt_secret' },
      { GF_ENV: 'production' },
    )).toBeNull();
  });

  /**
   * ⭐ `/b/:id` 目前**不在 `apps/web` 的路由表里** —— 后端在批 2 就做完了，
   * 承载它的页面还没上线。此时放链接等于给顾客一个失效的按钮，而模板在
   * 没有链接时会引导他打电话，那条路是通的。
   */
  it('🔴 页面未上线时不返回链接，且 apps/web 确实没有这条路由', () => {
    setEnv({ GF_ENV: 'production' });
    expect(manageBookingUrl({
      appointmentId: 'a1', manageToken: 'mt_x', publicKey: 'pk_1234',
    })).toBeNull();
    // 这一条在页面上线时会失败，提醒把 BOOKING_MANAGE_PAGE_ENABLED 打开
    expect(appTsx).not.toContain('path="/b/:');
  });

  it('邮件 logo 走营销站 PNG，文件真实存在', () => {
    setEnv({ GF_ENV: 'production' });
    expect(emailLogoUrl()).toBe(`${DEFAULT_MARKETING_BASE_URL}${PATHS.emailLogo}`);
    expect(PATHS.emailLogo.endsWith('.png')).toBe(true);
    const logo = join(here, '../../marketing/public/brand/geniefront-logo-email.png');
    expect(existsSync(logo)).toBe(true);
  });

  it('退订页挂在 desk 公开路由，不要求登录，也不走尚未托管 SPA 的 book 域名', () => {
    setEnv({ GF_ENV: 'production' });
    expect(emailUnsubscribeUrl('u_1')).toBe(`${DEFAULT_APP_BASE_URL}/unsubscribe?t=u_1`);
    expect(emailUnsubscribeUrl('u_1')).not.toContain('book.geniefront.com');
    expect(appTsx).toContain("/unsubscribe");
  });

  it('令牌做 URL 编码', () => {
    setEnv({ GF_ENV: 'production', BOOKING_MANAGE_PAGE_ENABLED: '1' });
    expect(formIntakeUrl('a b&c')).toContain('t=a%20b%26c');
    expect(manageBookingUrl({
      appointmentId: 'a1', manageToken: 'a b', publicKey: 'pk_1',
    })).toContain('t=a+b');
  });
});

describe('回跳地址', () => {
  it('合法的相对路径接到 APP_BASE_URL', () => {
    setEnv({ APP_BASE_URL: 'https://desk.geniefront.com' });
    expect(safePortalReturnUrl('/settings?tab=billing'))
      .toBe('https://desk.geniefront.com/settings?tab=billing');
  });

  it('缺省 path 落在设置页账单 tab', () => {
    setEnv({ GF_ENV: 'production' });
    expect(safePortalReturnUrl(undefined))
      .toBe(`${DEFAULT_APP_BASE_URL}${DEFAULT_PORTAL_RETURN_PATH}`);
    expect(safePortalReturnUrl(undefined)).not.toContain('geniefront.app');
  });

  it('任意外部 origin 不能成为 return_url', () => {
    setEnv({ APP_BASE_URL: 'https://desk.geniefront.com' });
    for (const evil of [
      'https://evil.example/phish', 'http://evil.example',
      '//evil.example/x', 'https://desk.geniefront.com.evil.example/',
    ]) {
      expect(safePortalReturnUrl(evil)).toBe('https://desk.geniefront.com/settings?tab=billing');
    }
  });

  it('Checkout 的 success/cancel 走同一条相对路径规则', () => {
    setEnv({ APP_BASE_URL: 'https://desk.geniefront.com/' });
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
    setEnv({ GF_ENV: 'production' });
    expect(marketingBaseUrl()).toBe(DEFAULT_MARKETING_BASE_URL);
    expect(signupReturnUrls()).toEqual({
      successUrl: 'https://www.geniefront.com/signup/success?session_id={CHECKOUT_SESSION_ID}',
      cancelUrl: 'https://www.geniefront.com/signup/cancel',
    });
    expect(signupReturnUrls().successUrl).not.toContain('geniefront.app');
    expect(signupReturnUrls().cancelUrl).not.toContain('desk.geniefront.com');
  });

  it('marketing 回跳不接受请求里的绝对 URL —— 只认服务端配置', () => {
    setEnv({ MARKETING_BASE_URL: 'https://www.geniefront.com/' });
    expect(signupReturnUrls().successUrl.startsWith('https://www.geniefront.com/')).toBe(true);
  });
});
