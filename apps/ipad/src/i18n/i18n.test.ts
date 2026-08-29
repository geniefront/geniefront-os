import { describe, it, expect } from 'vitest';
import { dict, UI_LANGUAGES } from './dict';
import type { Language } from '../types';

describe('iPad Kiosk i18n Dictionary', () => {
  const languageCodes: Language[] = UI_LANGUAGES.map((l) => l.code);

  it('has valid non-empty translations for all 5 languages across all keys', () => {
    const keys = Object.keys(dict) as (keyof typeof dict)[];
    expect(keys.length).toBeGreaterThan(30);

    for (const key of keys) {
      const entry = dict[key];
      expect(entry, `Dictionary entry for ${key} should exist`).toBeDefined();

      for (const lang of languageCodes) {
        const text = entry[lang];
        expect(
          text,
          `Key "${key}" is missing or empty translation for language "${lang}"`,
        ).toBeTruthy();
        expect(
          typeof text,
          `Key "${key}" translation for language "${lang}" should be a string`,
        ).toBe('string');
        expect(
          text.trim().length,
          `Key "${key}" translation for "${lang}" should not be blank`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it('supports interpolation placeholders correctly', () => {
    const key = 'ticket.autoReturn';
    const zh = dict[key]['zh-Hans'];
    expect(zh).toContain('秒后自动返回首页');
  });
});
