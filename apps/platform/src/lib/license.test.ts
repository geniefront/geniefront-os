import { describe, expect, it } from 'vitest';
import { centsFromUsdInput, intFromInput, licenseTermsText, usdFromCents } from './license';

/**
 * 「收了多少钱」这一格是运营台上唯一会**写进一行发票**的输入。
 *
 * ⚠️ 所以它不能用 `parseFloat`（宪法第 4 条：金额只用整数分）。
 * 这一组用例盯的就是那件事：小数位、边界、以及所有必须被**拒绝**
 * 而不是被猜出一个数的输入。
 */
describe('centsFromUsdInput', () => {
  it('整数与两位小数都转成整数分', () => {
    expect(centsFromUsdInput('1500')).toBe(150000);
    expect(centsFromUsdInput('99.00')).toBe(9900);
    expect(centsFromUsdInput('0.99')).toBe(99);
    expect(centsFromUsdInput('0')).toBe(0);
    expect(centsFromUsdInput(' 12.5 ')).toBe(1250);
  });

  /**
   * ⭐ 这一条是用 `parseFloat` 会出错的那个数。
   * `parseFloat('1.005') * 100` 是 100.49999999999999 —— 四舍五入成 100，
   * 少收半分钱。整数运算给的是 100（`.00` 截断在正则层就被拒了，
   * 三位小数根本进不来）。
   */
  it('三位以上小数被拒绝，而不是被悄悄取整', () => {
    expect(centsFromUsdInput('1.005')).toBeNull();
    expect(centsFromUsdInput('0.001')).toBeNull();
  });

  it('空、负数、千位分隔符、货币符号、文字一律拒绝', () => {
    for (const bad of ['', '   ', '-5', '1,500', '$1500', '15 00', 'abc', '1e3', '.5', '5.']) {
      expect(centsFromUsdInput(bad)).toBeNull();
    }
  });

  it('不接受超过七位整数 —— 那一定是把分当成了元', () => {
    expect(centsFromUsdInput('9999999')).toBe(999999900);
    expect(centsFromUsdInput('10000000')).toBeNull();
  });
});

describe('usdFromCents', () => {
  it('整数分格式化成美元，含千位分隔与两位小数', () => {
    expect(usdFromCents(150000)).toBe('$1,500.00');
    expect(usdFromCents(9900)).toBe('$99.00');
    expect(usdFromCents(5)).toBe('$0.05');
    expect(usdFromCents(0)).toBe('$0.00');
  });

  it('没写面值显示破折号，不显示 $0.00', () => {
    // ⚠️ 「没收钱」和「收了零元」在对账时是两件事
    expect(usdFromCents(null)).toBe('—');
  });

  it('负数（冲账）带符号', () => {
    expect(usdFromCents(-9900)).toBe('-$99.00');
  });
});

describe('licenseTermsText', () => {
  it('订阅码写套餐与天数', () => {
    expect(licenseTermsText({
      kind: 'subscription', plan: 'growth', durationDays: 90, unit: null, amount: null,
    })).toBe('Growth · 90 days');
  });

  it('额度包写单位与数量，两种额度分得清', () => {
    expect(licenseTermsText({
      kind: 'quota_pack', plan: null, durationDays: null, unit: 'credit', amount: 500,
    })).toBe('500 credits');
    expect(licenseTermsText({
      kind: 'quota_pack', plan: null, durationDays: null, unit: 'voice_minute', amount: 200,
    })).toBe('200 voice minutes');
  });
});

/**
 * 数量与天数。
 *
 * ⚠️ 半个积分、半天服务都没有意义，所以这里只收整数 ——
 * 而 `Number('500.5')` 是 `500.5`，会一路走到服务端换回一个 400。
 */
describe('intFromInput', () => {
  it('整数照收，前后空格无所谓', () => {
    expect(intFromInput('500')).toBe(500);
    expect(intFromInput(' 30 ')).toBe(30);
    expect(intFromInput('0')).toBe(0);
  });

  it('小数、空、文字、科学计数法一律拒绝', () => {
    for (const bad of ['500.5', '', '  ', 'abc', '1e3', '30d', '--5']) {
      expect(intFromInput(bad)).toBeNull();
    }
  });

  it('范围外拒绝，而不是钳到边界上', () => {
    // ⚠️ 钳的话运营填 5000 天会静默变成 3650 天 —— 他不会发现
    expect(intFromInput('5000', { min: 1, max: 3650 })).toBeNull();
    expect(intFromInput('0', { min: 1 })).toBeNull();
    expect(intFromInput('3650', { min: 1, max: 3650 })).toBe(3650);
  });

  it('缩期用的负数在放开下限时是合法的', () => {
    expect(intFromInput('-30', { min: -3650, max: 3650 })).toBe(-30);
    expect(intFromInput('-30', { min: 1 })).toBeNull();
  });
});
