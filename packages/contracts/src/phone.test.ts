import { describe, expect, it } from 'vitest';
import { formatPhoneInput, normalizePhoneE164, phoneE164 } from './command';

describe('phone normalization', () => {
  it.each([
    ['5125550142', '+15125550142'],
    ['(512) 555-0142', '+15125550142'],
    ['1 512 555 0142', '+15125550142'],
    ['+84 912 345 678', '+84912345678'],
    ['0084 912 345 678', '+84912345678'],
  ])('normalizes %s to E.164', (input, expected) => {
    expect(normalizePhoneE164(input)).toBe(expected);
    expect(phoneE164.parse(input)).toBe(expected);
  });

  it.each(['', '555-0142', '+0123456789', '(512) 555-0142 ext 9'])
    ('rejects ambiguous or invalid input %s', (input) => {
      expect(normalizePhoneE164(input)).toBeNull();
      expect(phoneE164.safeParse(input).success).toBe(false);
    });

  it('formats phone entry consistently for Web and Kiosk', () => {
    expect(formatPhoneInput('5125550142')).toBe('(512) 555-0142');
    expect(formatPhoneInput('+1 512 555 0142')).toBe('+1 (512) 555-0142');
    expect(formatPhoneInput('+84 912 345 678')).toBe('+84912345678');
  });
});
