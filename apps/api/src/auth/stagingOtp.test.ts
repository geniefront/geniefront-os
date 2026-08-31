/**
 * staging 手机验证码测试 provider。
 *
 * Twilio Verify 没有 Test Credentials 这条路，验证码只会真的发到真手机上 ——
 * 所以 staging 上「技师用手机号上机」在自动化里必须有一条应用侧的替身。
 * 这一组盯的是那条替身的三道锁：非生产、显式配了码、号码在白名单里。
 */

import { describe, it, expect, afterEach } from 'vitest';
import { checkPhoneCode, sendPhoneCode, stagingOtpApplies, verifyConfigured } from './phoneOtp';

const KEYS = ['GF_ENV', 'STAGING_OTP_CODE', 'STAGING_OTP_PHONES'] as const;
const saved = new Map<string, string | undefined>();

function setEnv(patch: Record<string, string | undefined>): void {
  for (const k of KEYS) if (!saved.has(k)) saved.set(k, process.env[k]);
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  saved.clear();
});

const staging = {
  GF_ENV: 'staging',
  STAGING_OTP_CODE: '424242',
  STAGING_OTP_PHONES: '+16175550100,+1617555999*',
};

describe('stagingOtpApplies', () => {
  it('白名单里的整号与前缀都算', () => {
    setEnv(staging);
    expect(stagingOtpApplies('+16175550100')).toBe(true);
    expect(stagingOtpApplies('+16175559991')).toBe(true);
    expect(stagingOtpApplies('+16175559999')).toBe(true);
  });

  it('⭐ 白名单之外的号码一律走真供应商 —— 没有默认白名单', () => {
    setEnv(staging);
    expect(stagingOtpApplies('+16175551234')).toBe(false);
    setEnv({ STAGING_OTP_PHONES: undefined });
    expect(stagingOtpApplies('+16175550100')).toBe(false);
  });

  it('⚠️ 生产永远不生效，哪怕环境变量配着', () => {
    setEnv({ ...staging, GF_ENV: 'production' });
    expect(stagingOtpApplies('+16175550100')).toBe(false);
  });

  it('码的格式不对就当没配（4–8 位数字）', () => {
    setEnv({ ...staging, STAGING_OTP_CODE: 'abc123' });
    expect(stagingOtpApplies('+16175550100')).toBe(false);
    setEnv({ ...staging, STAGING_OTP_CODE: '12' });
    expect(stagingOtpApplies('+16175550100')).toBe(false);
  });
});

describe('checkPhoneCode（测试 provider）', () => {
  it('固定码通过，其余一律不通过', async () => {
    setEnv(staging);
    expect(await checkPhoneCode('+16175550100', '424242')).toBe(true);
    expect(await checkPhoneCode('+16175550100', '000000')).toBe(false);
    // 长度不同也只是不通过，不抛异常：码不对是业务分支，不是故障
    expect(await checkPhoneCode('+16175550100', '42424')).toBe(false);
  });

  it('发码这一步什么都不发，也不抛异常', async () => {
    setEnv(staging);
    await expect(sendPhoneCode('+16175550100')).resolves.toBeUndefined();
  });

  it('配了固定码就算「这条路是通的」', () => {
    setEnv(staging);
    expect(verifyConfigured()).toBe(true);
  });
});
