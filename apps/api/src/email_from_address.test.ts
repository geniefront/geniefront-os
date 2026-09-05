/**
 * 事务性邮件的发件域名划分（`email/send.ts` 的 `fromAddressFor`）。
 *
 * 这一组守的是**信誉隔离**：营销邮件的投诉率天然高于事务性邮件，而发信域名的
 * 信誉按域名累积。三类邮件混用同一域名时，一家门店的营销投诉会直接拉低所有
 * 门店预约确认邮件的送达率 —— 而「预约确认进了垃圾箱」不会有任何人来投诉，
 * 只会表现为到店率下降。也就是说，**这里分错了不会报错**。
 */

import { describe, it, expect } from 'vitest';
import { fromAddressFor } from './email/send';
import { emailProvider, providerConfigured } from './email/provider';

const ENV = {
  FROM_EMAIL: 'GenieFront <noreply@notify.geniefront.com>',
  CUSTOMER_FROM_EMAIL: 'GenieFront Bookings <noreply@appointment.geniefront.com>',
} as NodeJS.ProcessEnv;

describe('发件地址按邮件类型选择', () => {
  it('客户事务邮件走 appointment 子域', () => {
    for (const kind of [
      'appointment_confirm', 'appointment_changed', 'appointment_reminder',
      'receipt', 'form_invite',
    ]) {
      expect(fromAddressFor({ kind }, ENV)).toBe(ENV['CUSTOMER_FROM_EMAIL']);
    }
  });

  it('店家事务邮件走 notify 子域', () => {
    for (const kind of [
      'platform_notice', 'trial_ending', 'payment_failed', 'subscription_canceled',
    ]) {
      expect(fromAddressFor({ kind }, ENV)).toBe(ENV['FROM_EMAIL']);
    }
  });

  /**
   * ⭐ 营销邮件必须从门店自己的营销地址发出
   * （`locations.marketing_email_from`，落在发件箱行的 `from_email` 上）。
   *
   * 🔴 它的优先级高于按 `kind` 的推断：营销邮件走的 `kind` 与预约变更相同
   * （见 `notify/dispatch.ts` 的 `outboxKind`），只看 kind 会把一家店的群发
   * 算到平台的顾客域头上。
   */
  it('🔴 行上已有 from_email 时一律优先，不看 kind', () => {
    expect(fromAddressFor(
      { from: 'spasite1@mkt.geniefront.com', kind: 'appointment_changed' }, ENV,
    )).toBe('spasite1@mkt.geniefront.com');
  });

  /**
   * ⚠️ 未登记的 `kind` 默认按**店家事务**处理。
   *
   * 新增一种店家通知时若忘记登记，后果只是发件域名不够贴切；反之若默认走
   * 顾客域，则会把店家邮件计入顾客域的信誉，属于静默污染。
   */
  it('⚠️ 未登记的 kind 默认按店家事务处理', () => {
    expect(fromAddressFor({ kind: 'some_future_kind' }, ENV)).toBe(ENV['FROM_EMAIL']);
    expect(fromAddressFor({}, ENV)).toBe(ENV['FROM_EMAIL']);
  });

  /**
   * ⚠️ `CUSTOMER_FROM_EMAIL` 是本次域名拆分新增的变量。未配置时回落到
   * `FROM_EMAIL` 而非拒发 —— 拆分是送达率优化，不应成为发信能力的前置条件，
   * 否则一次漏配环境变量会让所有预约确认邮件停发。
   */
  it('⚠️ 未配置 CUSTOMER_FROM_EMAIL 时回落到 FROM_EMAIL，而不是拒发', () => {
    const partial = { FROM_EMAIL: ENV['FROM_EMAIL'] } as NodeJS.ProcessEnv;
    expect(fromAddressFor({ kind: 'appointment_confirm' }, partial))
      .toBe(ENV['FROM_EMAIL']);
  });

  it('两个都没配时返回 undefined，由调用方记成 not_configured', () => {
    expect(fromAddressFor({ kind: 'appointment_confirm' }, {} as NodeJS.ProcessEnv))
      .toBeUndefined();
  });
});

/**
 * 供应商选择（`email/provider.ts`）。
 *
 * SES 账号在 2026-09-01 时仍处于沙箱：只有已验证的收件地址能收到邮件。
 * 因此**默认必须是 Resend** —— 误切到 SES 的后果是所有发往真实顾客的邮件
 * 被静默拒收，而发信侧看起来一切正常。
 */
describe('邮件供应商的选择', () => {
  it('未配置时默认 resend', () => {
    expect(emailProvider({} as NodeJS.ProcessEnv)).toBe('resend');
  });

  it('显式配 ses 才用 ses', () => {
    expect(emailProvider({ EMAIL_PROVIDER: 'ses' } as NodeJS.ProcessEnv)).toBe('ses');
    expect(emailProvider({ EMAIL_PROVIDER: 'resend' } as NodeJS.ProcessEnv)).toBe('resend');
  });

  it('大小写与首尾空白都容忍', () => {
    expect(emailProvider({ EMAIL_PROVIDER: '  SES ' } as NodeJS.ProcessEnv)).toBe('ses');
  });

  /**
   * 🔴 打错字必须回退到**当前能真正送达的那一家**，而不是抛错或回退到 SES。
   * 回退到 SES 的话，一个 typo 就让所有邮件进沙箱黑洞。
   */
  it('🔴 认不出的值拒绝启动，避免静默切换供应商', () => {
    for (const v of ['sess', 'aws', 'SES2', 'resnd']) {
      expect(() => emailProvider({ EMAIL_PROVIDER: v } as NodeJS.ProcessEnv)).toThrow('invalid_email_provider');
    }
    expect(emailProvider({ EMAIL_PROVIDER: '' } as NodeJS.ProcessEnv)).toBe('resend');
  });

  /** ⚠️ 两家的凭据各查各的 —— 配了 AWS 的 key 不代表 Resend 能发信。 */
  it('凭据按当前供应商判断，不串台', () => {
    const aws = { AWS_ACCESS_KEY_ID: 'a', AWS_SECRET_ACCESS_KEY: 'b' } as NodeJS.ProcessEnv;
    const resend = { RESEND_API_KEY: 're_x' } as NodeJS.ProcessEnv;

    expect(providerConfigured({ ...aws, EMAIL_PROVIDER: 'ses' })).toBe(true);
    expect(providerConfigured({ ...aws, EMAIL_PROVIDER: 'resend' })).toBe(false);
    expect(providerConfigured({ ...resend, EMAIL_PROVIDER: 'resend' })).toBe(true);
    expect(providerConfigured({ ...resend, EMAIL_PROVIDER: 'ses' })).toBe(false);
  });
});
