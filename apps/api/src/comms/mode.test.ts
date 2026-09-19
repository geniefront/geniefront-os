/**
 * 投递模式与启动闸门。
 *
 * 这一组盯的是两种**静默**失败：
 *   · capture 模式漏进生产 → 客人的确认信被吞掉，没有任何报错
 *   · 固定 OTP 漏进生产     → 任何人拿一个常量就能上机
 * 两者都只能用「起不来」来防，所以这里验的是 assertCommunicationSafety 抛不抛。
 */

import { describe, it, expect } from 'vitest';
import {
  captureForRecipient, assertCommunicationSafety, deliveryMode, isCaptureMode, isProductionEnv, mailpitEndpoint,
} from './mode';

describe('deliveryMode', () => {
  it('默认是 live —— 没配的时候必须真的发出去', () => {
    expect(deliveryMode({})).toBe('live');
    expect(deliveryMode({ COMMUNICATION_DELIVERY_MODE: '' })).toBe('live');
    // 拼错了也当 live：拼错导致「静默不发」是最糟的失败方式
    expect(deliveryMode({ COMMUNICATION_DELIVERY_MODE: 'captured' })).toBe('live');
  });

  it('capture 要显式写', () => {
    expect(deliveryMode({ COMMUNICATION_DELIVERY_MODE: 'capture' })).toBe('capture');
    expect(isCaptureMode({ COMMUNICATION_DELIVERY_MODE: 'capture' })).toBe(true);
  });
});

describe('isProductionEnv', () => {
  it('⭐ 权威是 GF_ENV：staging 部署同样带着 NODE_ENV=production', () => {
    // deploy/deploy.sh 给 staging 也写 NODE_ENV=production。拿它判环境的话，
    // staging 永远打不开 capture —— 这个开关等于不存在
    expect(isProductionEnv({ GF_ENV: 'staging', NODE_ENV: 'production' })).toBe(false);
    expect(isProductionEnv({ GF_ENV: 'local', NODE_ENV: 'production' })).toBe(false);
    expect(isProductionEnv({ GF_ENV: 'production', NODE_ENV: 'production' })).toBe(true);
  });

  it('⚠️ GF_ENV 缺失而 NODE_ENV=production 时按生产处理', () => {
    expect(isProductionEnv({ NODE_ENV: 'production' })).toBe(true);
    expect(isProductionEnv({ NODE_ENV: 'test' })).toBe(false);
    expect(isProductionEnv({})).toBe(false);
  });
});

describe('assertCommunicationSafety', () => {
  it('生产 + capture → 拒绝启动', () => {
    expect(() => assertCommunicationSafety({
      GF_ENV: 'production', COMMUNICATION_DELIVERY_MODE: 'capture',
    })).toThrow(/COMMUNICATION_DELIVERY_MODE=capture/);
  });

  it('生产 + 固定 OTP → 拒绝启动', () => {
    expect(() => assertCommunicationSafety({
      GF_ENV: 'production', STAGING_OTP_CODE: '123456',
    })).toThrow(/STAGING_OTP_CODE/);
    expect(() => assertCommunicationSafety({
      GF_ENV: 'production', STAGING_OTP_PHONES: '+1617555*',
    })).toThrow(/STAGING_OTP_PHONES/);
  });

  it('生产 + MAILPIT_URL → 拒绝启动', () => {
    expect(() => assertCommunicationSafety({
      GF_ENV: 'production', MAILPIT_URL: 'http://127.0.0.1:55324',
    })).toThrow(/MAILPIT_URL/);
  });

  it('staging 与 local 开着这些开关是正常的', () => {
    expect(() => assertCommunicationSafety({
      GF_ENV: 'staging',
      NODE_ENV: 'production',
      COMMUNICATION_DELIVERY_MODE: 'capture',
      STAGING_OTP_CODE: '424242',
      STAGING_OTP_PHONES: '+1617555*',
    })).not.toThrow();
  });

  it('干净的生产配置照常启动', () => {
    expect(() => assertCommunicationSafety({ GF_ENV: 'production' })).not.toThrow();
  });
});

describe('mailpitEndpoint', () => {
  it('只在 capture 模式下有效，且只接受本机地址', () => {
    const capture = { COMMUNICATION_DELIVERY_MODE: 'capture' };
    expect(mailpitEndpoint({ ...capture, MAILPIT_URL: 'http://127.0.0.1:55324' }))
      .toBe('http://127.0.0.1:55324/api/v1/send');
    // 指到外网就等于绕过 capture 偷偷真发
    expect(mailpitEndpoint({ ...capture, MAILPIT_URL: 'https://mail.example.com' })).toBeNull();
    expect(mailpitEndpoint({ MAILPIT_URL: 'http://127.0.0.1:55324' })).toBeNull();
    expect(mailpitEndpoint({ ...capture, MAILPIT_URL: '不是个 URL' })).toBeNull();
  });
});


describe('explicit staging test delivery', () => {
  const env = { GF_ENV: 'staging', COMMUNICATION_DELIVERY_MODE: 'capture', COMMUNICATION_LIVE_TEST_RECIPIENTS: 'test@example.com,+12025550123' };
  it('allows only exact authorized recipients in staging', () => {
    expect(captureForRecipient('test@example.com', env)).toBe(false);
    expect(captureForRecipient('+12025550123', env)).toBe(false);
    expect(captureForRecipient('other@example.com', env)).toBe(true);
    expect(captureForRecipient('test@example.com', { ...env, GF_ENV: 'local' })).toBe(true);
    expect(captureForRecipient('test@example.com', { ...env, NODE_ENV: 'test' })).toBe(true);
  });
});
