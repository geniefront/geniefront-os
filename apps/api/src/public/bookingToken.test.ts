import { describe, expect, it } from 'vitest';
import {
  assertManageTokenWrapSafety,
  generateManageToken, hashManageToken, unwrapManageToken, wrapManageToken,
} from './bookingToken';

const jwt = { APP_JWT_SECRET: 'booking-token-wrap-test-secret-at-least-32' };
const jwt2 = { APP_JWT_SECRET: 'booking-token-wrap-rotated-secret-32chars' };
const dedicated = {
  MANAGE_TOKEN_WRAP_KEY: 'dedicated-wrap-key-must-be-32-chars-min',
  APP_JWT_SECRET: jwt.APP_JWT_SECRET,
};

describe('manage token wrap', () => {
  it('round-trips a raw token and refuses a digest mismatch', () => {
    const token = generateManageToken();
    const digest = hashManageToken(token);
    const wrapped = wrapManageToken(token, jwt);
    expect(wrapped).toBeInstanceOf(Buffer);
    expect(wrapped!.includes(Buffer.from(token, 'utf8'))).toBe(false);
    expect(unwrapManageToken(wrapped, digest, jwt)).toBe(token);
    expect(unwrapManageToken(wrapped, hashManageToken(generateManageToken()), jwt)).toBeNull();
  });

  it('omits reconstruction when the wrap key is missing', () => {
    const token = generateManageToken();
    expect(wrapManageToken(token, {})).toBeNull();
    expect(unwrapManageToken(Buffer.from('x'), hashManageToken(token), {})).toBeNull();
  });

  it('unwraps legacy APP_JWT_SECRET wraps after JWT rotation via PREVIOUS', () => {
    const token = generateManageToken();
    const digest = hashManageToken(token);
    const wrapped = wrapManageToken(token, jwt);
    expect(unwrapManageToken(wrapped, digest, jwt2)).toBeNull();
    expect(unwrapManageToken(wrapped, digest, {
      APP_JWT_SECRET: jwt2.APP_JWT_SECRET,
      APP_JWT_SECRET_PREVIOUS: jwt.APP_JWT_SECRET,
    })).toBe(token);
  });

  it('prefers the dedicated wrap key so JWT rotation does not break new wraps', () => {
    const token = generateManageToken();
    const digest = hashManageToken(token);
    const wrapped = wrapManageToken(token, dedicated);
    expect(unwrapManageToken(wrapped, digest, {
      MANAGE_TOKEN_WRAP_KEY: dedicated.MANAGE_TOKEN_WRAP_KEY,
      APP_JWT_SECRET: jwt2.APP_JWT_SECRET,
    })).toBe(token);
    expect(unwrapManageToken(wrapped, digest, jwt)).toBeNull();
  });

  it('unwraps dedicated wraps after dedicated-key rotation via PREVIOUS', () => {
    const token = generateManageToken();
    const digest = hashManageToken(token);
    const wrapped = wrapManageToken(token, dedicated);
    const rotated = {
      MANAGE_TOKEN_WRAP_KEY: 'dedicated-wrap-key-rotated-32-chars-min',
      MANAGE_TOKEN_WRAP_KEY_PREVIOUS: dedicated.MANAGE_TOKEN_WRAP_KEY,
      APP_JWT_SECRET: jwt.APP_JWT_SECRET,
    };
    expect(unwrapManageToken(wrapped, digest, rotated)).toBe(token);
  });
});

describe('assertManageTokenWrapSafety', () => {
  it('refuses short secrets on staging and production', () => {
    expect(() => assertManageTokenWrapSafety({
      GF_ENV: 'production', APP_JWT_SECRET: 'short',
    })).toThrow(/APP_JWT_SECRET/);
    expect(() => assertManageTokenWrapSafety({
      GF_ENV: 'staging', APP_JWT_SECRET: 'x'.repeat(32), MANAGE_TOKEN_WRAP_KEY: 'tiny',
    })).toThrow(/MANAGE_TOKEN_WRAP_KEY/);
  });

  it('accepts a 32-character JWT secret and ignores local/test', () => {
    expect(() => assertManageTokenWrapSafety({
      GF_ENV: 'production', APP_JWT_SECRET: 'x'.repeat(32),
    })).not.toThrow();
    expect(() => assertManageTokenWrapSafety({
      GF_ENV: 'local', APP_JWT_SECRET: 'short',
    })).not.toThrow();
  });
});
