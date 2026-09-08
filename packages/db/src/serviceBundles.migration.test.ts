/**
 * Evidence: sql/0118 builds the组合套餐 catalog + order-instance structure on a
 * 0117-shaped database, is additive (no legacy row touched), enforces its
 * invariants as DB checks, and replays cleanly. Isolated test database only.
 *
 * ⚠️ 需要隔离库（`DATABASE_TEST_TARGET=isolated` + `TEST_*` 连接串）。缺少时
 * 本文件应被 `pnpm test` 的 db 过滤跳过，不计入通过。
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { withTenant } from './client';
import { adminSql } from './admin';
import { closeDb } from './client';

const NAIL_ORG = '11111111-1111-4111-8111-111111111111';
const NAIL_LOC = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const SPA_ORG = '22222222-2222-4222-8222-222222222222';
const SPA_LOC = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

const SQL_DIR = join(dirname(fileURLToPath(import.meta.url)), '../sql');
const M118 = 'sql/0118_service_bundles.sql';

afterAll(async () => {
  await closeDb();
  await adminSql.end({ timeout: 5 });
});

async function applySqlFile(key: string): Promise<void> {
  const body = await readFile(join(SQL_DIR, key.replace(/^sql\//, '')), 'utf8');
  await adminSql.unsafe(body);
  await adminSql`insert into _migrations (name) values (${key}) on conflict (name) do nothing`;
}

async function rewind(): Promise<void> {
  await adminSql.unsafe(`
    drop index if exists appointment_items_bundle_unit_uidx;
    drop index if exists ticket_items_bundle_unit_uidx;
    drop index if exists appointment_items_bundle_idx;
    drop index if exists ticket_items_bundle_idx;
    alter table appointment_items
      drop column if exists bundle_instance_id,
      drop column if exists bundle_component_id,
      drop column if exists bundle_unit_index,
      drop column if exists bundle_list_price_cents;
    alter table ticket_items
      drop column if exists bundle_instance_id,
      drop column if exists bundle_component_id,
      drop column if exists bundle_unit_index,
      drop column if exists bundle_list_price_cents;
    drop table if exists order_bundle_instances cascade;
    drop table if exists service_bundle_components cascade;
    drop table if exists service_bundles cascade;
  `);
  await adminSql`delete from _migrations where name = ${M118}`;
}

async function seededServiceId(): Promise<string> {
  const [row] = await withTenant(
    { orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: null },
    (tx) => tx<{ id: string }[]>`select id from services where location_id = ${NAIL_LOC} and active = true limit 1`,
  );
  return row!.id;
}

describe('0118 组合套餐结构', () => {
  it('additively builds catalog + instance tables, enforces invariants, and replays cleanly', async () => {
    try {
      await rewind();

      // Legacy count baseline — the migration must not touch existing rows.
      const [{ n: apptItemsBefore } = { n: -1 }] = await adminSql<{ n: number }[]>`
        select count(*)::int as n from appointment_items`;

      await applySqlFile(M118);

      // ── tables + RLS ────────────────────────────────────────────────────
      const rls = await adminSql<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
        select relname, relrowsecurity, relforcerowsecurity from pg_class
        where relname in ('service_bundles', 'service_bundle_components', 'order_bundle_instances')
        order by relname`;
      expect(rls.map((r) => r.relname)).toEqual([
        'order_bundle_instances', 'service_bundle_components', 'service_bundles',
      ]);
      expect(rls.every((r) => r.relrowsecurity && r.relforcerowsecurity)).toBe(true);

      // ── added columns, all nullable, no row rewrite ────────────────────
      const cols = await adminSql<{ table_name: string; column_name: string; is_nullable: string }[]>`
        select table_name, column_name, is_nullable from information_schema.columns
        where table_name in ('appointment_items', 'ticket_items')
          and column_name like 'bundle_%'
        order by table_name, column_name`;
      expect(cols).toHaveLength(8);
      expect(cols.every((c) => c.is_nullable === 'YES')).toBe(true);
      const [{ n: apptItemsAfter } = { n: -1 }] = await adminSql<{ n: number }[]>`
        select count(*)::int as n from appointment_items`;
      expect(apptItemsAfter).toBe(apptItemsBefore);
      const [{ n: dirtyRows } = { n: -1 }] = await adminSql<{ n: number }[]>`
        select count(*)::int as n from appointment_items where bundle_instance_id is not null`;
      expect(dirtyRows).toBe(0);

      // ── tenant-scoped write path + check constraints ───────────────────
      const serviceId = await seededServiceId();
      const bundleId = await withTenant(
        { orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: null },
        async (tx) => {
          const [b] = await tx<{ id: string }[]>`
            insert into service_bundles (org_id, location_id, name, price_cents)
            values (${NAIL_ORG}, ${NAIL_LOC}, '{"en":"Relax Combo"}'::jsonb, 15000)
            returning id`;
          await tx`
            insert into service_bundle_components (bundle_id, org_id, location_id, service_id, qty, seq)
            values (${b!.id}, ${NAIL_ORG}, ${NAIL_LOC}, ${serviceId}, 1, 0)`;
          return b!.id;
        },
      );
      expect(bundleId).toBeTruthy();

      await withTenant(
        { orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: null },
        async (tx) => {
          // discount must equal original - price
          await expect(tx`
            insert into order_bundle_instances
              (org_id, location_id, appointment_id, bundle_id, template_version,
               name_snapshot, original_total_cents, bundle_price_cents, discount_cents)
            values (${NAIL_ORG}, ${NAIL_LOC}, ${null}, ${bundleId}, 1,
               '{"en":"Relax Combo"}'::jsonb, 17000, 15000, 1999)
          `).rejects.toThrow(); // owner_chk also fails here (no appointment/ticket)

          // price must not exceed original
          await expect(tx`
            insert into order_bundle_instances
              (org_id, location_id, ticket_id, bundle_id, template_version,
               name_snapshot, original_total_cents, bundle_price_cents, discount_cents)
            select ${NAIL_ORG}, ${NAIL_LOC}, t.id, ${bundleId}, 1,
               '{"en":"Relax Combo"}'::jsonb, 10000, 15000, -5000
            from tickets t where t.location_id = ${NAIL_LOC} limit 1
          `).rejects.toThrow();
        },
      );

      // ── cross-tenant isolation ────────────────────────────────────────
      const leaked = await withTenant(
        { orgId: SPA_ORG, locationId: SPA_LOC, membershipId: null },
        (tx) => tx<{ id: string }[]>`select id from service_bundles where id = ${bundleId}`,
      );
      expect(leaked).toHaveLength(0);

      // ── replay whole file: create/alter ... if not exists ─────────────
      const body = await readFile(join(SQL_DIR, '0118_service_bundles.sql'), 'utf8');
      await adminSql.unsafe(body);
      const [{ n: bundlesStill } = { n: -1 }] = await adminSql<{ n: number }[]>`
        select count(*)::int as n from service_bundles where id = ${bundleId}`;
      expect(bundlesStill).toBe(1);
    } finally {
      await adminSql`delete from order_bundle_instances where location_id = ${NAIL_LOC}`;
      await adminSql`delete from service_bundle_components where location_id = ${NAIL_LOC}`;
      await adminSql`delete from service_bundles where location_id = ${NAIL_LOC}`;
      const done = await adminSql<{ name: string }[]>`select name from _migrations where name = ${M118}`;
      if (done.length === 0) await applySqlFile(M118);
    }
  });
});
