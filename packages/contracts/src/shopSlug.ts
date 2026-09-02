/**
 * Hosted booking shop slug: the public path at book.geniefront.com/{slug}.
 *
 * This is a lookup key, not a secret. The same canonical form is used by
 * location.saveProfile, the hosted bootstrap endpoint, and sql/0095.
 * Keep this list and gf_shop_slug_reserved() in lockstep.
 */

export const RESERVED_SHOP_SLUGS = [
  'l',
  'g',
  'b',
  'assets',
  'api',
  'public',
  'health',
  'login',
  'admin',
] as const;

export const RESERVED_SHOP_SLUG_SET: ReadonlySet<string> = new Set(RESERVED_SHOP_SLUGS);

export const SHOP_SLUG_MIN_LENGTH = 2;
export const SHOP_SLUG_MAX_LENGTH = 64;

export type ShopSlugReason = 'slug_invalid' | 'slug_reserved';

export type ShopSlugParseResult =
  | { ok: true; slug: string }
  | { ok: false; reason: ShopSlugReason };

const CANONICAL_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Fold a raw shop slug (or shop name) into lowercase ASCII letters, digits,
 * and single hyphens. Does not enforce length or reserved names.
 */
export function canonicalizeShopSlug(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function parseShopSlug(raw: string): ShopSlugParseResult {
  const slug = canonicalizeShopSlug(raw);
  if (RESERVED_SHOP_SLUG_SET.has(slug)) {
    return { ok: false, reason: 'slug_reserved' };
  }
  if (
    slug.length < SHOP_SLUG_MIN_LENGTH
    || slug.length > SHOP_SLUG_MAX_LENGTH
    || !CANONICAL_RE.test(slug)
  ) {
    return { ok: false, reason: 'slug_invalid' };
  }
  return { ok: true, slug };
}

/**
 * Signup / location.create slug: readable prefix plus a short entropy suffix
 * so two shops named "Lotus Spa" do not collide.
 */
export function shopSlugFromName(name: string, suffix: string): string {
  const trimmedSuffix = suffix.replace(/[^a-z0-9]/gi, '').toLowerCase();
  const entropy = trimmedSuffix || 'shop';
  const room = Math.max(SHOP_SLUG_MIN_LENGTH, SHOP_SLUG_MAX_LENGTH - 1 - entropy.length);
  const base = (canonicalizeShopSlug(name) || 'shop').slice(0, room).replace(/-+$/g, '') || 'shop';
  return `${base}-${entropy}`;
}
