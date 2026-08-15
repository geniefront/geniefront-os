import { describe, it, expect } from 'vitest';
import { dollarsToCents } from './command.js';

describe('金额输入解析（宪法第 4 条）', () => {
  it('常规金额', () => {
    expect(dollarsToCents('12.34')).toBe(1234);
    expect(dollarsToCents('55')).toBe(5500);
    expect(dollarsToCents('0.05')).toBe(5);
    expect(dollarsToCents('.5')).toBe(50);
  });

  it('⭐ 浮点会算错的那些值', () => {
    // Number('1.005') * 100 = 100.49999999999999 → Math.round 得 100
    expect(dollarsToCents('1.005')).toBe(100);   // 截断到两位，不进位
    expect(dollarsToCents('8.15')).toBe(815);    // Number('8.15')*100 = 814.9999...
    expect(dollarsToCents('1.115')).toBe(111);
    expect(dollarsToCents('29.97')).toBe(2997);
  });

  it('脏输入不炸', () => {
    expect(dollarsToCents('$20')).toBe(2000);
    expect(dollarsToCents('  12.5 ')).toBe(1250);
    expect(dollarsToCents('')).toBe(0);
    expect(dollarsToCents('abc')).toBe(0);
    expect(dollarsToCents('.')).toBe(0);
  });

  it('多余小数位直接截断 —— 收银时多收比少收更糟', () => {
    expect(dollarsToCents('10.999')).toBe(1099);
  });
});
