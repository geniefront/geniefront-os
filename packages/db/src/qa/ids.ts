import { createHash } from 'node:crypto';

/** Deterministic UUID (version-4 shape) from a stable seed string. */
export function qaUuid(seed: string): string {
  const hash = createHash('md5').update(`gf-qa-v2:${seed}`).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Deterministic 22-char Crockford-like gift-card code (no ILOU). */
export function qaGiftCardCode(seed: string): string {
  const hash = createHash('sha256').update(`gf-qa-gc:${seed}`).digest();
  let out = '';
  for (let i = 0; i < 22; i++) {
    out += CROCKFORD[hash[i]! % CROCKFORD.length];
  }
  return out;
}

export function publicKeyFor(locationId: string): string {
  return `pk_${locationId.replace(/-/g, '').slice(0, 24)}`;
}

export function qaEmail(local: string): string {
  return `qa-${local}@maildrop.cc`;
}
