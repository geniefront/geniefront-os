/**
 * Evidence: 0095 repairs invalid/duplicate slugs from a 0094-shaped database
 * and is safe to replay. Uses the isolated test database only.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { parseShopSlug } from '@gf/contracts';
import { adminSql } from './admin';
import { closeDb } from './client';

const NAIL_ORG = '11111111-1111-4111-8111-111111111111';
const NAIL_LOC = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const SPA_LOC = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

const INVALID_ID = '11111111-9999-4999-8999-111111111001';
const DUPLICATE_ID = '22222222-9999-4999-8999-222222222002';
const RESERVED_ID = '33333333-9999-4999-8999-333333333003';
const EXTRA_IDS = [INVALID_ID, DUPLICATE_ID, RESERVED_ID];

const SQL_DIR = join(dirname(fileURLToPath(import.meta.url)), '../sql');
const M095 = 'sql/0095_hosted_booking_slug.sql';
const M096 = 'sql/0096_hosted_shop_slug_resolve.sql';
const M097 = 'sql/0097_restrict_staff_own_appointment_items.sql';

afterAll(async () => {
  await closeDb();
  await adminSql.end({ timeout: 5 });
});

async function applied(): Promise<Set<string>> {
  const rows = await adminSql<{ name: string }[]>`select name from _migrations`;
  return new Set(rows.map((r) => r.name));
}

async function applySqlFile(key: string): Promise<void> {
  const file = key.replace(/^sql\//, '');
  const body = await readFile(join(SQL_DIR, file), 'utf8');
  await adminSql.unsafe(body);
  await adminSql`insert into _migrations (name) values (${key}) on conflict (name) do nothing`;
}

async function rewindTo0094(): Promise<void> {
  await adminSql.unsafe(`
    drop policy if exists location_by_public_slug on locations;
    drop policy if exists org_by_public_slug on organizations;
    drop policy if exists origins_by_public_slug on location_allowed_origins;
    drop function if exists app_public_slug();
    alter table locations drop constraint if exists locations_slug_format_chk;
    drop index if exists locations_slug_uidx;
    drop function if exists gf_repair_shop_slugs();
    drop function if exists gf_shop_slug_taken(text, uuid);
    drop function if exists gf_shop_slug_canonical(text);
    drop function if exists gf_shop_slug_reserved(text);
    drop function if exists gf_normalize_shop_slug(text);
  `);
  await adminSql`delete from _migrations where name = any(${[M095, M096]})`;
}

async function ensureCurrentMigrations(): Promise<void> {
  const done = await applied();
  if (!done.has(M095)) await applySqlFile(M095);
  if (!done.has(M096)) await applySqlFile(M096);
  if (!done.has(M097)) await applySqlFile(M097);
}

async function deleteExtras(): Promise<void> {
  await adminSql`delete from locations where id = any(${EXTRA_IDS})`;
}

describe('0095 from a 0094-shaped database', () => {
  it('rewrites invalid and duplicate slugs, keeps live slugs, and replays cleanly', async () => {
    try {
      await rewindTo0094();
      const done = await applied();
      expect(done.has(M095)).toBe(false);
      expect(done.has(M096)).toBe(false);

      const [idx] = await adminSql<{ n: number }[]>`
        select count(*)::int as n from pg_indexes
        where schemaname = 'public' and indexname = 'locations_slug_uidx'`;
      expect(idx?.n).toBe(0);

      await adminSql`
        insert into locations (id, org_id, name, slug, timezone, business_type, status)
        values
          (${INVALID_ID}, ${NAIL_ORG}, '{"en":"Invalid Slug"}'::jsonb,
           'Lotus Nails!!', 'America/New_York', 'nail', 'setup'),
          (${DUPLICATE_ID}, ${NAIL_ORG}, '{"en":"Duplicate Slug"}'::jsonb,
           'lotus-nails', 'America/New_York', 'nail', 'setup'),
          (${RESERVED_ID}, ${NAIL_ORG}, '{"en":"Reserved Slug"}'::jsonb,
           'admin', 'America/New_York', 'nail', 'setup')`;

      await applySqlFile(M095);

      const rows = await adminSql<{ id: string; slug: string }[]>`
        select id, slug from locations
        where id in (${NAIL_LOC}, ${SPA_LOC}, ${INVALID_ID}, ${DUPLICATE_ID}, ${RESERVED_ID})`;
      const byId = Object.fromEntries(rows.map((r) => [r.id, r.slug]));

      // Live canonical slugs stay pointed at the same shops.
      expect(byId[NAIL_LOC]).toBe('lotus-nails');
      expect(byId[SPA_LOC]).toBe('golden-foot');

      // Invalid and colliding rows get a deterministic suffix; they do not steal lotus-nails.
      expect(byId[INVALID_ID]).toBe('lotus-nails-11111111');
      expect(byId[DUPLICATE_ID]).toBe('lotus-nails-22222222');
      expect(byId[RESERVED_ID]).toBe('shop');
      expect(parseShopSlug(byId[INVALID_ID]!).ok).toBe(true);
      expect(parseShopSlug(byId[DUPLICATE_ID]!).ok).toBe(true);
      expect(parseShopSlug(byId[RESERVED_ID]!).ok).toBe(true);

      const [firstReplay] = await adminSql<{ changed: number }[]>`
        select gf_repair_shop_slugs() as changed`;
      expect(firstReplay?.changed).toBe(0);

      // Re-run the whole file: CREATE OR REPLACE / IF NOT EXISTS / repair no-op.
      const body = await readFile(join(SQL_DIR, '0095_hosted_booking_slug.sql'), 'utf8');
      await adminSql.unsafe(body);

      const [secondReplay] = await adminSql<{ changed: number }[]>`
        select gf_repair_shop_slugs() as changed`;
      expect(secondReplay?.changed).toBe(0);

      const afterReplay = await adminSql<{ id: string; slug: string }[]>`
        select id, slug from locations
        where id in (${NAIL_LOC}, ${SPA_LOC}, ${INVALID_ID}, ${DUPLICATE_ID}, ${RESERVED_ID})
        order by id`;
      expect(Object.fromEntries(afterReplay.map((r) => [r.id, r.slug]))).toEqual(byId);
    } finally {
      await deleteExtras();
      await ensureCurrentMigrations();
    }
  });
});
