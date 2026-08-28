/**
 * 整数金额强制转换的行为约束。
 *
 * ⚠️ 这几条断言对应的是**已经发生过的一类事故**：把 Postgres 返回的
 * bigint 字符串或接口 JSON 里的字段用裸 `Number()` 转换，非整数输入被
 * 安静地接受，随后每一次累加都把小数分带下去，最终日结对不上账
 * 而无法定位是哪一单引入的。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { asInt, asCents } from './command.js';

afterEach(() => vi.restoreAllMocks());

describe('asInt / asCents', () => {
  it('接受整数、bigint 与整数字符串', () => {
    expect(asInt(1234)).toBe(1234);
    expect(asInt(-1234)).toBe(-1234);
    expect(asInt(0)).toBe(0);
    expect(asInt(9007199254740991n)).toBe(9007199254740991);
    expect(asInt('4200')).toBe(4200);
    expect(asInt('  -7  ')).toBe(-7);
  });

  it('缺失值回退到 fallback', () => {
    expect(asInt(null)).toBe(0);
    expect(asInt(undefined)).toBe(0);
    expect(asInt('')).toBe(0);
    expect(asInt(undefined, 1800)).toBe(1800);
  });

  it('拒绝非整数而非就地取整', () => {
    // 关键行为：不得返回 10.5，也不得返回 11 —— 猜测会把上游契约错误藏起来
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(asInt('10.5')).toBe(0);
    expect(asInt(10.5)).toBe(0);
    expect(asInt('abc')).toBe(0);
    expect(asInt('10.5', 99)).toBe(99);
  });

  it('拒绝超出安全整数范围的值', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(asInt('99999999999999999999')).toBe(0);
  });

  it('非整数输入会在开发环境显式告警', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    asCents('10.5');
    expect(spy).toHaveBeenCalledOnce();
  });

  it('asCents 与 asInt 行为一致', () => {
    expect(asCents('4200')).toBe(asInt('4200'));
  });
});
