import { describe, expect, it } from 'vitest';
import { formatPhoneInput } from './phone';

describe('formatPhoneInput', () => {
  it('formats North American input consistently', () => {
    expect(formatPhoneInput('5125550142')).toBe('(512) 555-0142');
    expect(formatPhoneInput('+1 512 555 0142')).toBe('+1 (512) 555-0142');
  });

  it('keeps explicit international country codes', () => {
    expect(formatPhoneInput('+84 912 345 678')).toBe('+84912345678');
  });
});
