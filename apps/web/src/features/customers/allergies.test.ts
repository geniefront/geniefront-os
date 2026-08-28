/**
 * 过敏与禁忌信息的判空与呈现测试。
 *
 * 这一栏是床边最需要可信的信息。出现「{}」这类噪音会让技师不再认真看它 ——
 * 而真正有禁忌的那一次，代价是客人受伤。
 */
import { describe, it, expect } from 'vitest';
import { hasAllergyContent, formatAllergies } from './allergies';

describe('hasAllergyContent', () => {
  it('空值一律判为无内容', () => {
    expect(hasAllergyContent(null)).toBe(false);
    expect(hasAllergyContent(undefined)).toBe(false);
    expect(hasAllergyContent('')).toBe(false);
    expect(hasAllergyContent('   ')).toBe(false);
    expect(hasAllergyContent({})).toBe(false);
    expect(hasAllergyContent([])).toBe(false);
  });

  it('有内容时判为有', () => {
    expect(hasAllergyContent('薰衣草精油')).toBe(true);
    expect(hasAllergyContent(['乳胶'])).toBe(true);
    expect(hasAllergyContent({ latex: true })).toBe(true);
  });
});

describe('formatAllergies', () => {
  it('字符串原样返回', () => {
    expect(formatAllergies('对薰衣草过敏')).toBe('对薰衣草过敏');
  });

  it('数组用顿号连接', () => {
    expect(formatAllergies(['乳胶', '薰衣草'])).toBe('乳胶、薰衣草');
  });

  it('对象展开为可读文本，布尔真值只显示键名', () => {
    expect(formatAllergies({ latex: true, note: '腰部避开' })).toBe('latex、note：腰部避开');
  });

  it('对象中的空值不产生噪音', () => {
    expect(formatAllergies({ latex: true, note: '', other: null, no: false })).toBe('latex');
  });
});
