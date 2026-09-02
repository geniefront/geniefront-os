/**
 * Hosted booking slug contract (sql/0095, location.saveProfile).
 *
 * Public keys stay as they are: the slug is a human-readable lookup key,
 * not an authorization secret.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '@gf/contracts';
import { closeDb, withTenant } from '@gf/db';
import { buildContext } from './actor';
import { dispatch } from './bus';
import './handlers/setup';

const NAIL_ORG = '11111111-1111-4111-8111-111111111111';
const NAIL_LOC = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const SPA_ORG = '22222222-2222-4222-8222-222222222222';
const SPA_LOC = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

const nailTenant = { orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: null };
const spaTenant = { orgId: SPA_ORG, locationId: SPA_LOC, membershipId: null };

let nailCtx: Awaited<ReturnType<typeof buildContext>>;
let spaCtx: Awaited<ReturnType<typeof buildContext>>;
let nailSlug = '';
let spaSlug = '';
let nailPublicKey = '';
let spaPublicKey = '';

const token = randomUUID().replace(/-/g, '').slice(0, 8);
const claimed = `hb1-${token}`;

async function loadLocation(tenant: typeof nailTenant) {
  const [row] = await withTenant(tenant, (tx) => tx<{ slug: string; public_key: string }[]>`
    select slug, public_key from locations where id = ${tenant.locationId}`);
  return row!;
}

async function ownerOrManagerCtx(tenant: typeof nailTenant, role: 'owner' | 'manager') {
  const [m] = await withTenant(tenant, (tx) => tx<{ id: string; user_id: string }[]>`
    select m.id, m.user_id from memberships m
    join membership_roles mr on mr.membership_id = m.id
    join roles r on r.id = mr.role_id
    where m.location_id = ${tenant.locationId}
      and m.status = 'active'
      and m.user_id is not null
      and r.key = ${role}
    limit 1`);
  return buildContext({ userId: m!.user_id, membershipId: m!.id });
}

beforeAll(async () => {
  const nail = await loadLocation(nailTenant);
  const spa = await loadLocation(spaTenant);
  nailSlug = nail.slug;
  spaSlug = spa.slug;
  nailPublicKey = nail.public_key;
  spaPublicKey = spa.public_key;
  nailCtx = await ownerOrManagerCtx(nailTenant, 'manager');
  spaCtx = await ownerOrManagerCtx(spaTenant, 'owner');
});

afterAll(async () => {
  try {
    if (nailCtx && nailSlug) {
      await dispatch('location.saveProfile', { slug: nailSlug }, nailCtx);
    }
    if (spaCtx && spaSlug) {
      await dispatch('location.saveProfile', { slug: spaSlug }, spaCtx);
    }
  } finally {
    await closeDb();
  }
});

describe('hosted booking slug', () => {
  it('keeps an already-valid slug when the rest of the profile is saved', async () => {
    await dispatch('location.saveProfile', { timezone: 'America/New_York' }, nailCtx);
    const after = await loadLocation(nailTenant);
    expect(after.slug).toBe(nailSlug);
    expect(after.public_key).toBe(nailPublicKey);
  });

  it('lets a shop claim a canonical slug and keeps the public key unchanged', async () => {
    await dispatch('location.saveProfile', { slug: claimed.toUpperCase() }, nailCtx);
    const after = await loadLocation(nailTenant);
    expect(after.slug).toBe(claimed);
    expect(after.public_key).toBe(nailPublicKey);
  });

  it('rejects the same canonical slug from another organization', async () => {
    await expect(
      dispatch('location.saveProfile', { slug: claimed }, spaCtx),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { reason: 'slug_unavailable', slug: claimed },
    });
    const after = await loadLocation(spaTenant);
    expect(after.slug).toBe(spaSlug);
    expect(after.public_key).toBe(spaPublicKey);
  });

  it('treats case and punctuation variants as the same slug', async () => {
    const variant = `HB1_${token}`;
    expect(variant.toLowerCase().replace(/_/g, '-')).toBe(claimed);
    await expect(
      dispatch('location.saveProfile', { slug: variant }, spaCtx),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { reason: 'slug_unavailable' },
    } satisfies Partial<AppError>);
  });

  it('rejects reserved slugs', async () => {
    for (const reserved of ['admin', 'login', 'API', 'Public']) {
      await expect(
        dispatch('location.saveProfile', { slug: reserved }, spaCtx),
      ).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
        details: { reason: 'slug_reserved' },
      });
    }
  });

  it('lets a shop keep re-saving its own slug', async () => {
    const again = await dispatch<{ locationId: string }>(
      'location.saveProfile',
      { slug: claimed },
      nailCtx,
    );
    expect(again.result.locationId).toBe(NAIL_LOC);
    expect((await loadLocation(nailTenant)).slug).toBe(claimed);
  });
});
