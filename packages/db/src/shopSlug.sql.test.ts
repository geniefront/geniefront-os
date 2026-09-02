/**
 * sql/0095 hosted-booking slug: SQL function contract and replay-safe repair.
 */

import { afterAll, describe, expect, it } from 'vitest';
import {
  canonicalizeShopSlug,
  parseShopSlug,
  RESERVED_SHOP_SLUGS,
} from '@gf/contracts';
import { adminSql } from './admin';
import { closeDb, sql, withTenant } from './client';
import { withPublicSlug } from './publicBooking';

const NAIL_ORG = '11111111-1111-4111-8111-111111111111';
const NAIL_LOC = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const SPA_ORG = '22222222-2222-4222-8222-222222222222';
const SPA_LOC = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

afterAll(async () => {
  await closeDb();
  await adminSql.end({ timeout: 5 });
});

describe('gf_normalize_shop_slug', () => {
  it.each([
    ['Lotus-Nails', 'lotus-nails'],
    [' lotus_nails ', 'lotus-nails'],
    ['LOTUS.NAILS', 'lotus-nails'],
    ['lotus-nails', 'lotus-nails'],
  ])('matches the TypeScript canonicalizer for %j', async (raw, expected) => {
    expect(canonicalizeShopSlug(raw)).toBe(expected);
    const [row] = await adminSql<{ slug: string | null }[]>`
      select gf_normalize_shop_slug(${raw}) as slug`;
    expect(row?.slug).toBe(expected);
  });
});

describe('gf_shop_slug_reserved', () => {
  it('flags the same reserved set as TypeScript', async () => {
    for (const reserved of RESERVED_SHOP_SLUGS) {
      expect(parseShopSlug(reserved).ok).toBe(false);
      const [row] = await adminSql<{ reserved: boolean }[]>`
        select gf_shop_slug_reserved(${reserved}) as reserved`;
      expect(row?.reserved).toBe(true);
    }
  });
});

describe('gf_repair_shop_slugs', () => {
  it('leaves existing valid seed slugs alone and is replay-safe', async () => {
    const before = await adminSql<{ id: string; slug: string }[]>`
      select id, slug from locations order by id`;
    const byId = Object.fromEntries(before.map((r) => [r.id, r.slug]));
    expect(byId[NAIL_LOC]).toBe('lotus-nails');
    expect(byId[SPA_LOC]).toBe('golden-foot');
    expect(new Set(before.map((r) => r.slug)).size).toBe(before.length);
    for (const row of before) {
      expect(parseShopSlug(row.slug)).toEqual({ ok: true, slug: row.slug });
    }

    const [first] = await adminSql<{ changed: number }[]>`
      select gf_repair_shop_slugs() as changed`;
    const [second] = await adminSql<{ changed: number }[]>`
      select gf_repair_shop_slugs() as changed`;
    expect(first?.changed).toBe(0);
    expect(second?.changed).toBe(0);

    const after = await adminSql<{ id: string; slug: string }[]>`
      select id, slug from locations order by id`;
    expect(after).toEqual(before);
  });

  it('rejects a duplicate slug at the unique index even across organizations', async () => {
    await expect(adminSql`
      update locations set slug = 'lotus-nails' where id = ${SPA_LOC}
    `).rejects.toMatchObject({ code: '23505' });
    const [row] = await adminSql<{ slug: string }[]>`
      select slug from locations where id = ${SPA_LOC}`;
    expect(row?.slug).toBe('golden-foot');
  });

  it('rejects reserved and non-canonical slugs at the check constraint', async () => {
    await expect(adminSql`
      update locations set slug = 'admin' where id = ${SPA_LOC}
    `).rejects.toMatchObject({ code: '23514' });
    await expect(adminSql`
      update locations set slug = 'Golden-Foot' where id = ${SPA_LOC}
    `).rejects.toMatchObject({ code: '23514' });
  });
});

describe('withPublicSlug', () => {
  it('resolves the same shop a public key would, and nothing else', async () => {
    const shop = await withPublicSlug('lotus-nails');
    expect(shop?.locationId).toBe(NAIL_LOC);
    expect(shop?.slug).toBe('lotus-nails');
    expect(shop?.publicKey).toMatch(/^pk_/);

    expect(await withPublicSlug('no-such-shop-zzzz')).toBeNull();
    expect(await withPublicSlug('admin')).toBeNull();
  });

  it('does not expose customer rows through the slug session', async () => {
    const customers = await sql.begin(async (tx) => {
      await tx`select
        set_config('app.public_slug', 'lotus-nails', true),
        set_config('app.org_id', '', true),
        set_config('app.location_id', '', true)`;
      return tx<{ id: string }[]>`select id from customers`;
    });
    expect(customers).toEqual([]);
  });

  it('cannot read appointments, tickets, earnings, or usage_events in a slug session', async () => {
    const counts = await sql.begin(async (tx) => {
      await tx`select
        set_config('app.public_slug',       'lotus-nails', true),
        set_config('app.public_key',        '',            true),
        set_config('app.org_id',            '',            true),
        set_config('app.location_id',       '',            true),
        set_config('app.user_id',           '',            true),
        set_config('app.device_token_hash', '',            true)`;

      const one = async (table: string) => {
        const rows = await tx.unsafe(`select 1 as ok from ${table} limit 5`) as { ok: number }[];
        return rows.length;
      };

      return {
        locations: await one('locations'),
        organizations: await one('organizations'),
        origins: await one('location_allowed_origins'),
        appointments: await one('appointments'),
        appointmentItems: await one('appointment_items'),
        tickets: await one('tickets'),
        earnings: await one('earnings'),
        usageEvents: await one('usage_events'),
        customers: await one('customers'),
        staffProfiles: await one('staff_profiles'),
        services: await one('services'),
      };
    });

    // Slug policy is only on locations / org / allowed origins.
    expect(counts.locations).toBe(1);
    expect(counts.organizations).toBe(1);
    expect(counts.appointments).toBe(0);
    expect(counts.appointmentItems).toBe(0);
    expect(counts.tickets).toBe(0);
    expect(counts.earnings).toBe(0);
    expect(counts.usageEvents).toBe(0);
    expect(counts.customers).toBe(0);
    expect(counts.staffProfiles).toBe(0);
    expect(counts.services).toBe(0);
  });
});

describe('gf_shop_slug_taken', () => {
  it('is visible to app_user across tenants', async () => {
    const taken = await withTenant(
      { orgId: SPA_ORG, locationId: SPA_LOC, membershipId: null },
      (tx) => tx<{ taken: boolean }[]>`
        select gf_shop_slug_taken('lotus-nails', ${SPA_LOC}) as taken`,
    );
    expect(taken[0]?.taken).toBe(true);

    const own = await withTenant(
      { orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: null },
      (tx) => tx<{ taken: boolean }[]>`
        select gf_shop_slug_taken('lotus-nails', ${NAIL_LOC}) as taken`,
    );
    expect(own[0]?.taken).toBe(false);
  });
});
