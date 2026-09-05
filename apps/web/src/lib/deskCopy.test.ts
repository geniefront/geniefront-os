import { describe, expect, it } from 'vitest';
import { formatPermissionKey, formatValidityPeriod, giftCardStatusKey } from './deskCopy';

describe('formatValidityPeriod', () => {
  it('永久有效时不再拼「天」', () => {
    expect(formatValidityPeriod(null, '永久', (d) => `${d} 天`)).toBe('永久');
    expect(formatValidityPeriod(0, '永久', (d) => `${d} 天`)).toBe('永久');
  });

  it('有天数时带单位', () => {
    expect(formatValidityPeriod(30, '永久', (d) => `${d} 天`)).toBe('30 天');
  });
});

describe('formatPermissionKey', () => {
  it('把原始权限键拆成可读片段，不再整串下划线', () => {
    expect(formatPermissionKey('ai.execute_without_confirm')).toBe('ai · execute without confirm');
  });
});

describe('giftCardStatusKey', () => {
  it('ACTIVE 不是展示文案，只是状态枚举', () => {
    expect(giftCardStatusKey('ACTIVE')).toBe('active');
    expect(giftCardStatusKey('expired')).toBe('expired');
  });
});
