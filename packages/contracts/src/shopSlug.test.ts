import { describe, expect, it } from 'vitest';
import {
  canonicalizeShopSlug,
  parseShopSlug,
  shopSlugFromName,
  RESERVED_SHOP_SLUGS,
} from './shopSlug';

describe('canonicalizeShopSlug', () => {
  it.each([
    ['Lotus-Nails', 'lotus-nails'],
    [' lotus_nails ', 'lotus-nails'],
    ['LOTUS.NAILS', 'lotus-nails'],
    ['Lotus   Nails', 'lotus-nails'],
    ['lotus--nails', 'lotus-nails'],
    ['-lotus-nails-', 'lotus-nails'],
    ['lotus-nails', 'lotus-nails'],
  ])('folds %j to %j', (raw, expected) => {
    expect(canonicalizeShopSlug(raw)).toBe(expected);
  });
});

describe('parseShopSlug', () => {
  it('accepts a canonical slug', () => {
    expect(parseShopSlug('lotus-nails')).toEqual({ ok: true, slug: 'lotus-nails' });
  });

  it('accepts case and punctuation variants of a valid slug', () => {
    expect(parseShopSlug('Lotus_Nails')).toEqual({ ok: true, slug: 'lotus-nails' });
  });

  it('rejects reserved paths after normalization', () => {
    for (const reserved of RESERVED_SHOP_SLUGS) {
      expect(parseShopSlug(reserved)).toEqual({ ok: false, reason: 'slug_reserved' });
      expect(parseShopSlug(reserved.toUpperCase())).toEqual({ ok: false, reason: 'slug_reserved' });
    }
  });

  it.each(['', ' ', '-', 'a', '!!', '中文店'])('rejects invalid input %j', (raw) => {
    expect(parseShopSlug(raw)).toEqual({ ok: false, reason: 'slug_invalid' });
  });

  it('rejects slugs longer than 64 after normalization', () => {
    expect(parseShopSlug(`ab-${'c'.repeat(62)}`)).toEqual({ ok: false, reason: 'slug_invalid' });
  });
});

describe('shopSlugFromName', () => {
  it('keeps two identically named shops distinct', () => {
    const a = shopSlugFromName('Lotus Spa', 'aaaaaa');
    const b = shopSlugFromName('Lotus Spa', 'bbbbbb');
    expect(a).toBe('lotus-spa-aaaaaa');
    expect(b).toBe('lotus-spa-bbbbbb');
    expect(a).not.toBe(b);
    expect(parseShopSlug(a).ok).toBe(true);
  });

  it('does not emit a reserved exact slug when the shop is named Admin', () => {
    const slug = shopSlugFromName('Admin', 'abcdef');
    expect(slug).toBe('admin-abcdef');
    expect(parseShopSlug(slug)).toEqual({ ok: true, slug: 'admin-abcdef' });
  });
});
