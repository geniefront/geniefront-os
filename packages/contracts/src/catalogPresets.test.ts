import { describe, expect, it } from 'vitest';
import {
  INDUSTRY_CATALOG_PRESETS,
  catalogPresetForBusinessType,
  CATALOG_PRESET_VERSION,
} from './catalogPresets';
import { LOCALES } from './command';

const UI_LOCALES = ['zh-Hans', 'en', 'ko', 'es', 'vi'] as const;

describe('catalog presets', () => {
  it('covers the six non-mixed business types', () => {
    expect(INDUSTRY_CATALOG_PRESETS.map((p) => p.businessType).sort()).toEqual(
      ['foot_spa', 'hair', 'lash', 'massage', 'nail', 'scalp'],
    );
  });

  it('has a stable, unique preset key for every service', () => {
    for (const preset of INDUSTRY_CATALOG_PRESETS) {
      const keys = preset.services.map((s) => s.presetKey);
      expect(new Set(keys).size, preset.businessType).toBe(keys.length);
      for (const key of keys) expect(key.startsWith(`${preset.businessType}.`)).toBe(true);
    }
  });

  it('localizes every name into all five UI languages', () => {
    for (const preset of INDUSTRY_CATALOG_PRESETS) {
      for (const locale of UI_LOCALES) {
        expect(preset.name[locale]?.trim(), `${preset.businessType} industry name / ${locale}`).toBeTruthy();
      }
      for (const service of preset.services) {
        for (const locale of UI_LOCALES) {
          expect(service.name[locale]?.trim(), `${service.presetKey} / ${locale}`).toBeTruthy();
        }
        // 键必须是有效的服务端 locale
        for (const key of Object.keys(service.name)) {
          expect((LOCALES as readonly string[]).includes(key), key).toBe(true);
        }
      }
    }
  });

  it('keeps prices as positive integer cents and durations sane', () => {
    for (const preset of INDUSTRY_CATALOG_PRESETS) {
      for (const service of preset.services) {
        expect(Number.isInteger(service.basePriceCents)).toBe(true);
        expect(service.basePriceCents).toBeGreaterThan(0);
        expect(service.durationMin).toBeGreaterThanOrEqual(0);
        expect(service.durationMin).toBeLessThanOrEqual(600);
      }
    }
  });

  it('resolves by business type and returns null for mixed / unknown', () => {
    expect(catalogPresetForBusinessType('nail')?.businessType).toBe('nail');
    expect(catalogPresetForBusinessType('mixed')).toBeNull();
    expect(catalogPresetForBusinessType(null)).toBeNull();
    expect(catalogPresetForBusinessType('salon')).toBeNull();
  });

  it('exposes a version number', () => {
    expect(CATALOG_PRESET_VERSION).toBeGreaterThanOrEqual(1);
  });
});
