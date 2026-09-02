import { describe, expect, it } from 'vitest';
import {
  generateManageToken, hashManageToken, unwrapManageToken, wrapManageToken,
} from './bookingToken';

const env = { APP_JWT_SECRET: 'booking-token-wrap-test-secret-at-least-32' };

describe('manage token wrap', () => {
  it('round-trips a raw token and refuses a digest mismatch', () => {
    const token = generateManageToken();
    const digest = hashManageToken(token);
    const wrapped = wrapManageToken(token, env);
    expect(wrapped).toBeInstanceOf(Buffer);
    expect(wrapped!.includes(Buffer.from(token, 'utf8'))).toBe(false);
    expect(unwrapManageToken(wrapped, digest, env)).toBe(token);
    expect(unwrapManageToken(wrapped, hashManageToken(generateManageToken()), env)).toBeNull();
  });

  it('omits reconstruction when the wrap key is missing', () => {
    const token = generateManageToken();
    expect(wrapManageToken(token, {})).toBeNull();
    expect(unwrapManageToken(Buffer.from('x'), hashManageToken(token), {})).toBeNull();
  });
});
