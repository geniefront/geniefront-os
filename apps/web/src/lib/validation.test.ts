/**
 * 输入格式判定的回归护栏。
 *
 * 重点不在「合法输入算得对」，而在 **非法输入必须判为非法** —— 本模块存在的
 * 理由正是全站此前普遍把非法输入静默换成一个默认值（0 元、30 分钟）。
 */
import { describe, expect, it } from 'vitest';
import { parseCount, parseDurationMinutes, parseEmail, parseMoney, parsePercent, parsePin } from './validation';
import { dollarsToCents } from '@/features/checkout/api';

describe('parseMoney', () => {
  it('按字符串与整数运算，不经浮点', () => {
    // 1.005 * 100 在浮点下是 100.49999999999999，四舍五入会少一分
    expect(parseMoney('1.005')).toEqual({ ok: true, value: 100 });
    expect(parseMoney('45')).toEqual({ ok: true, value: 4500 });
    expect(parseMoney('45.5')).toEqual({ ok: true, value: 4550 });
    expect(parseMoney('45.50')).toEqual({ ok: true, value: 4550 });
  });

  it('多余小数位截断而非进位 —— 宁可少收，不可多收', () => {
    expect(parseMoney('9.999')).toEqual({ ok: true, value: 999 });
  });

  it('容忍货币符号与千分位：那是书写习惯，不是错误', () => {
    expect(parseMoney('$1,299.99')).toEqual({ ok: true, value: 129_999 });
  });

  it('对合法输入与 dollarsToCents 结果一致', () => {
    for (const input of ['0', '45', '45.5', '45.50', '1.005', '9.999', '1299.99']) {
      const parsed = parseMoney(input);
      expect(parsed.ok && parsed.value).toBe(dollarsToCents(input));
    }
  });

  it('非法输入判为非法，而不是像 dollarsToCents 那样静默归零', () => {
    expect(dollarsToCents('abc')).toBe(0); // 这正是要拦住的既有行为
    expect(parseMoney('abc')).toEqual({ ok: false, reason: 'format' });
    expect(parseMoney('12abc')).toEqual({ ok: false, reason: 'format' });
    expect(parseMoney('1.2.3')).toEqual({ ok: false, reason: 'format' });
    expect(parseMoney('')).toEqual({ ok: false, reason: 'empty' });
    expect(parseMoney('.')).toEqual({ ok: false, reason: 'format' });
  });

  it('默认不接受负数，显式允许时才放行', () => {
    expect(parseMoney('-5')).toEqual({ ok: false, reason: 'negative' });
    expect(parseMoney('-5', { allowNegative: true })).toEqual({ ok: true, value: -500 });
  });

  it('拦住多打一位的手滑', () => {
    expect(parseMoney('99999999')).toEqual({ ok: false, reason: 'tooLarge' });
    expect(parseMoney('500', { maxCents: 10_000 })).toEqual({ ok: false, reason: 'tooLarge' });
  });

  it('允许留空时空串记为 0', () => {
    expect(parseMoney('', { allowEmpty: true })).toEqual({ ok: true, value: 0 });
    expect(parseMoney('  ', { allowEmpty: true })).toEqual({ ok: true, value: 0 });
  });
});

describe('parseDurationMinutes', () => {
  it('只接受整数分钟', () => {
    expect(parseDurationMinutes('45')).toEqual({ ok: true, value: 45 });
    expect(parseDurationMinutes('45.5')).toEqual({ ok: false, reason: 'format' });
    expect(parseDurationMinutes('abc')).toEqual({ ok: false, reason: 'format' });
    expect(parseDurationMinutes('')).toEqual({ ok: false, reason: 'empty' });
  });

  it('边界随场景给出：目录项目不得短于 5 分钟，预约内可到 1 分钟', () => {
    expect(parseDurationMinutes('3', { min: 5 })).toEqual({ ok: false, reason: 'range' });
    expect(parseDurationMinutes('3', { min: 1 })).toEqual({ ok: true, value: 3 });
    expect(parseDurationMinutes('900')).toEqual({ ok: false, reason: 'range' });
  });
});

describe('parseEmail', () => {
  it('拦住当场可见的手误', () => {
    expect(parseEmail('mia')).toEqual({ ok: false, reason: 'format' });
    expect(parseEmail('mia@')).toEqual({ ok: false, reason: 'format' });
    expect(parseEmail('mia@maildrop')).toEqual({ ok: false, reason: 'format' });
    expect(parseEmail('mia @maildrop.cc')).toEqual({ ok: false, reason: 'format' });
    expect(parseEmail('')).toEqual({ ok: false, reason: 'empty' });
  });

  it('合法地址统一转小写后返回', () => {
    expect(parseEmail('  Mia@Maildrop.CC ')).toEqual({ ok: true, value: 'mia@maildrop.cc' });
    expect(parseEmail('a.b+tag@sub.example.co.uk').ok).toBe(true);
  });
});

describe('parsePin', () => {
  it('只接受 4–6 位数字', () => {
    expect(parsePin('1234')).toEqual({ ok: true, value: '1234' });
    expect(parsePin('123456')).toEqual({ ok: true, value: '123456' });
    expect(parsePin('123')).toEqual({ ok: false, reason: 'format' });
    expect(parsePin('1234567')).toEqual({ ok: false, reason: 'format' });
    expect(parsePin('12a4')).toEqual({ ok: false, reason: 'format' });
  });
});

describe('parseCount', () => {
  it('只接受正整数并遵守区间', () => {
    expect(parseCount('5')).toEqual({ ok: true, value: 5 });
    expect(parseCount('0')).toEqual({ ok: false, reason: 'range' });
    expect(parseCount('2.5')).toEqual({ ok: false, reason: 'format' });
    expect(parseCount('12', { max: 10 })).toEqual({ ok: false, reason: 'range' });
  });
});

describe('parsePercent', () => {
  it('按字符串转 basis point，不经浮点', () => {
    // 8.875 * 100 在浮点下是 887.4999999999999，直接取整会少一个 bp
    expect(parsePercent('8.875')).toEqual({ ok: true, value: 887 });
    expect(parsePercent('0')).toEqual({ ok: true, value: 0 });
    expect(parsePercent('8.25')).toEqual({ ok: true, value: 825 });
    expect(parsePercent('100')).toEqual({ ok: true, value: 10_000 });
  });

  it('容忍百分号：那是书写习惯', () => {
    expect(parsePercent('8.25%')).toEqual({ ok: true, value: 825 });
  });

  it('非法输入判为非法，而不是像 parseFloat(x) || 0 那样静默归零', () => {
    // 这正是要拦住的既有行为：打错一个字符，从此每一单都不收税
    expect(Number.parseFloat('8.25%abc') || 0).toBe(8.25); // parseFloat 还会截半段
    expect(Number.parseFloat('abc') || 0).toBe(0);
    expect(parsePercent('abc')).toEqual({ ok: false, reason: 'format' });
    expect(parsePercent('8.25.1')).toEqual({ ok: false, reason: 'format' });
    expect(parsePercent('-5')).toEqual({ ok: false, reason: 'format' });
    expect(parsePercent('')).toEqual({ ok: false, reason: 'empty' });
  });

  it('遵守上限与小数位上限', () => {
    expect(parsePercent('120')).toEqual({ ok: false, reason: 'range' });
    expect(parsePercent('30', { max: 25 })).toEqual({ ok: false, reason: 'range' });
    expect(parsePercent('8.1234')).toEqual({ ok: false, reason: 'format' });
  });

  it('允许留空时空串记为 0', () => {
    expect(parsePercent('', { allowEmpty: true })).toEqual({ ok: true, value: 0 });
  });
});

 describe('database checkout rates', () => {
  it('accepts numeric scale padding without truncating checkout rates', () => {
    for (const rate of ['0.0000', '8.2500', '8.8750']) expect(parsePercent(rate).ok).toBe(true);
    expect(parsePercent('8.8750', { fractionalBp: true, maxDecimals: 4 })).toEqual({ ok: true, value: 887.5 });
    expect(parsePercent('8.1234', { fractionalBp: true, maxDecimals: 4 })).toEqual({ ok: true, value: 812.34 });
    expect(parsePercent('8.2o')).toEqual({ ok: false, reason: 'format' });
  });
});
