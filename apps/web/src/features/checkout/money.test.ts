/**
 * 金额换算的回归测试。
 *
 * 这一层出错不会抛异常，只会让账目差几分 —— 门店会为差一分来问，
 * 而这类误差只在特定小数上出现，无法靠肉眼复核发现。
 */
import { describe, it, expect } from 'vitest';
import { dollarsToCents, centsToDollars } from './api';

describe('dollarsToCents', () => {
  it('常规金额', () => {
    expect(dollarsToCents('85')).toBe(8500);
    expect(dollarsToCents('85.5')).toBe(8550);
    expect(dollarsToCents('85.55')).toBe(8555);
  });

  it('浮点乘法会出错的输入必须正确', () => {
    // Number('1.005') * 100 === 100.49999999999999，四舍五入后是 100
    expect(dollarsToCents('1.005')).toBe(100);
    expect(dollarsToCents('0.07')).toBe(7);
    expect(dollarsToCents('1.10')).toBe(110);
  });

  it('多余小数位截断而非进位，宁可少收不可多收', () => {
    expect(dollarsToCents('1.999')).toBe(199);
  });

  it('容忍货币符号与空白', () => {
    expect(dollarsToCents(' $85.50 ')).toBe(8550);
  });

  it('空输入与非法输入归零，不产生 NaN', () => {
    expect(dollarsToCents('')).toBe(0);
    expect(dollarsToCents('abc')).toBe(0);
    expect(dollarsToCents('.')).toBe(0);
    expect(Number.isNaN(dollarsToCents('..'))).toBe(false);
  });
});

describe('centsToDollars', () => {
  it('始终两位小数', () => {
    expect(centsToDollars(8500)).toBe('85.00');
    expect(centsToDollars(8505)).toBe('85.05');
    expect(centsToDollars(7)).toBe('0.07');
    expect(centsToDollars(0)).toBe('0.00');
  });

  it('负数（找零、抵扣）', () => {
    expect(centsToDollars(-1550)).toBe('-15.50');
  });

  it('空值与非法输入归零，不产生 NaN', () => {
    expect(centsToDollars(undefined)).toBe('0.00');
    expect(centsToDollars(null)).toBe('0.00');
    expect(centsToDollars(Number.NaN)).toBe('0.00');
  });

  it('与 dollarsToCents 往返一致', () => {
    for (const v of ['0.01', '1.00', '85.55', '1234.99']) {
      expect(centsToDollars(dollarsToCents(v))).toBe(v);
    }
  });
});
