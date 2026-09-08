/**
 * U10 组合套餐目录 handler：saveTemplate / archiveTemplate / quote。
 * 隔离库集成测试（DATABASE_TEST_TARGET=isolated）。
 */

import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { withTenant, closeDb } from '@gf/db';
import { buildContext } from './actor';
import { dispatch } from './bus';
import { quoteBundle } from './queries/bundle';
import './handlers/setup';
import './handlers/bundle';
import './handlers/appointment';
import './handlers/ticket';

const NAIL = { orgId: '11111111-1111-4111-8111-111111111111', locationId: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', membershipId: null };
const SPA = { orgId: '22222222-2222-4222-8222-222222222222', locationId: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', membershipId: null };

let ctx: Awaited<ReturnType<typeof buildContext>>;
let A: string; let B: string; let C: string; let ADDON: string;
let staffId: string;

async function ownerCtx(tenant: typeof NAIL) {
  const [owner] = await withTenant(tenant, (tx) => tx<{ id: string; user_id: string }[]>`
    select m.id, m.user_id from memberships m
    join membership_roles mr on mr.membership_id = m.id
    join roles r on r.id = mr.role_id
    where m.location_id = ${tenant.locationId} and r.key in ('owner', 'manager') and m.user_id is not null
    limit 1`);
  return buildContext({ membershipId: owner!.id, userId: owner!.user_id });
}

const mkService = async (name: string, cents: number, isAddon = false) => {
  const r = await dispatch<{ serviceId: string }>('catalog.saveService', {
    name: { en: name, 'zh-Hans': name },
    durationMin: isAddon ? 10 : 30,
    basePriceCents: cents,
    ...(isAddon ? { isAddon: true } : {}),
  }, ctx);
  return r.result.serviceId;
};

const tag = () => `u10-${Math.random().toString(36).slice(2, 8)}`;

beforeAll(async () => {
  ctx = await ownerCtx(NAIL);
  A = await mkService(`${tag()} A`, 10_000);
  B = await mkService(`${tag()} B`, 5_000);
  C = await mkService(`${tag()} C`, 2_000);
  ADDON = await mkService(`${tag()} hot-stone`, 1_500, true);
  const [staff] = await withTenant(NAIL, (tx) => tx<{ id: string }[]>`
    select sp.membership_id as id from staff_profiles sp
    join memberships m on m.id = sp.membership_id
    where sp.location_id = ${NAIL.locationId} and sp.is_bookable = true and m.status = 'active'
    limit 1`);
  staffId = staff!.id;
});
afterAll(closeDb);

const save = (input: Record<string, unknown>) =>
  dispatch<{ bundleId: string; created: boolean; version: number }>('bundle.saveTemplate', input, ctx);

const abc = () => ({
  name: { en: `${tag()} Relax Combo`, 'zh-Hans': '套餐' },
  priceCents: 15_000,
  components: [
    { serviceId: A, qty: 1, seq: 0 },
    { serviceId: B, qty: 1, seq: 1 },
    { serviceId: C, qty: 1, seq: 2 },
  ],
});

describe('bundle.saveTemplate', () => {
  it('creates a template with components and version 1', async () => {
    const r = await save(abc());
    expect(r.result).toMatchObject({ created: true, version: 1 });
    const rows = await withTenant(NAIL, (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from service_bundle_components where bundle_id = ${r.result.bundleId}`);
    expect(rows[0]!.n).toBe(3);
  });

  it('rejects a price above the components total (§4.1)', async () => {
    await expect(save({ ...abc(), priceCents: 17_001 }))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED', details: { reason: 'bundle_price_above_components' } });
  });

  it('rejects fewer than two execution units', async () => {
    await expect(save({ ...abc(), components: [{ serviceId: A, qty: 1, seq: 0 }] }))
      .rejects.toMatchObject({ details: { reason: 'bundle_component_empty' } });
  });

  it('rejects an add-on used as a component service', async () => {
    await expect(save({
      ...abc(),
      components: [{ serviceId: A, qty: 1, seq: 0 }, { serviceId: ADDON, qty: 1, seq: 1 }],
    })).rejects.toMatchObject({ details: { reason: 'bundle_component_service_invalid' } });
  });

  it('bumps version on edit and enforces the optimistic lock', async () => {
    const created = await save(abc());
    const edited = await save({ ...abc(), bundleId: created.result.bundleId, priceCents: 14_000 });
    expect(edited.result).toMatchObject({ created: false, version: 2 });
    await expect(save({ ...abc(), bundleId: created.result.bundleId, expectedVersion: 1 }))
      .rejects.toMatchObject({ details: { reason: 'bundle_version_conflict' } });
  });
});

describe('quoteBundle (只读查询)', () => {
  let bundleId: string;
  beforeAll(async () => { bundleId = (await save(abc())).result.bundleId; });

  const quote = (req: Record<string, unknown> = {}) => withTenant(NAIL, (tx) => quoteBundle(
    tx, { locationId: NAIL.locationId },
    { bundleId, extraAddons: [], extraDiscountCents: 0, extraDiscountKind: 'manual', ...req } as any,
  ));

  it('expands A/B/C, sums bundle net to the locked price, matches §6.1 / B20', async () => {
    const q = await quote();
    expect(q.originalTotalCents).toBe(17_000);
    expect(q.bundleDiscountCents).toBe(2_000);
    expect(q.units.reduce((n, u) => n + u.bundleNetCents, 0)).toBe(15_000);
    const byService = Object.fromEntries(q.units.map((u) => [u.serviceId, u.bundleNetCents]));
    expect(byService[C]).toBe(1_764);
    expect(byService[A]! + byService[B]!).toBe(13_236);
  });

  it('adds an extra add-on at full price (no bundle discount) → service net 16500', async () => {
    const base = await quote();
    const q = await quote({ extraAddons: [{ ref: 'x1', attachToUnit: base.units[0]!.unitKey, serviceId: ADDON, qty: 1 }] });
    expect(q.extraAddonListTotalCents).toBe(1_500);
    expect(q.serviceNetTotalCents).toBe(16_500);
    expect(q.extraAddons[0]!.netCents).toBe(1_500);
    expect(q.extraAddons[0]!.unitOrdinal).toBe(0);
  });

  it('manual extra discount ($20 off $150 → $130) spreads across sub-items', async () => {
    const q = await quote({ extraDiscountCents: 2_000 });
    expect(q.units.reduce((n, u) => n + u.netCents, 0)).toBe(13_000);
    expect(q.units.every((u) => u.extraDiscountCents > 0)).toBe(true);
  });

  it('coupon extra discount with no eligible add-on is rejected (§4.5)', async () => {
    await expect(quote({ extraDiscountCents: 500, extraDiscountKind: 'coupon' }))
      .rejects.toMatchObject({ details: { reason: 'extra_discount_exceeds_eligible' } });
  });

  it('rejects a version mismatch', async () => {
    await expect(quote({ expectedVersion: 999 }))
      .rejects.toMatchObject({ details: { reason: 'bundle_version_conflict' } });
  });

  it('is invisible to another tenant and to archived bundles', async () => {
    await expect(withTenant(SPA, (tx) => quoteBundle(
      tx, { locationId: SPA.locationId },
      { bundleId, extraAddons: [], extraDiscountCents: 0, extraDiscountKind: 'manual' } as any,
    ))).rejects.toMatchObject({ details: { reason: 'bundle_not_found' } });

    await dispatch('bundle.archiveTemplate', { bundleId }, ctx);
    await expect(quote()).rejects.toMatchObject({ details: { reason: 'bundle_not_found' } });
  });
});

describe('appointment.create + bundleSelections (P3a)', () => {
  const startsAt = new Date(Date.now() + 26 * 60 * 60 * 1000).toISOString();

  const createWith = (bundleSelections: unknown[], items: unknown[] = []) =>
    dispatch<{ appointmentId: string; itemIds: string[]; bundleInstanceIds: string[] }>(
      'appointment.create',
      {
        customerId: null, walkInName: 'U10 test', items, bundleSelections,
        source: 'desk', override: { reason: 'desk_coordination' },
      },
      ctx, { idempotencyKey: randomUUID() },
    ).then((r) => r.result);

  const itemsOf = (appointmentId: string) => withTenant(NAIL, (tx) => tx<{
    service_id: string; price_cents_snapshot: number; duration_min: number; seq: number;
    starts_at: string; ends_at: string; addon_ids: string[];
    bundle_instance_id: string | null; bundle_component_id: string | null;
    bundle_unit_index: number | null; bundle_list_price_cents: number | null;
  }[]>`select service_id, price_cents_snapshot, duration_min, seq, starts_at, ends_at, addon_ids,
          bundle_instance_id, bundle_component_id, bundle_unit_index, bundle_list_price_cents
     from appointment_items where appointment_id = ${appointmentId} order by seq`);

  const instancesOf = (appointmentId: string) => withTenant(NAIL, (tx) => tx<{
    id: string; ticket_id: string | null; original_total_cents: number;
    bundle_price_cents: number; discount_cents: number; extra_discount_cents: number; status: string;
  }[]>`select id, ticket_id, original_total_cents, bundle_price_cents, discount_cents,
          extra_discount_cents, status
     from order_bundle_instances where appointment_id = ${appointmentId}`);

  it('expands one bundle into linked sub-items summing to the locked price', async () => {
    const bundleId = (await save(abc())).result.bundleId;
    const res = await createWith([{ bundleId, startsAt }]);

    expect(res.bundleInstanceIds).toHaveLength(1);
    const items = await itemsOf(res.appointmentId);
    expect(items).toHaveLength(3);
    expect(items.every((i) => i.bundle_instance_id === res.bundleInstanceIds[0])).toBe(true);
    expect(items.map((i) => i.bundle_unit_index)).toEqual([0, 0, 0]);
    expect(new Set(items.map((i) => i.bundle_component_id)).size).toBe(3);
    expect(items.reduce((n, i) => n + i.price_cents_snapshot, 0)).toBe(15_000);
    // 顺排：每个子项接着上一个
    expect(new Date(items[1]!.starts_at).getTime()).toBe(new Date(items[0]!.ends_at).getTime());

    const inst = await instancesOf(res.appointmentId);
    expect(inst).toHaveLength(1);
    expect(inst[0]).toMatchObject({
      ticket_id: null, original_total_cents: 17_000, bundle_price_cents: 15_000,
      discount_cents: 2_000, extra_discount_cents: 0, status: 'active',
    });
  });

  it('two of the same bundle + a loose item → two distinct instances, no cross-linkage', async () => {
    const bundleId = (await save(abc())).result.bundleId;
    const loose = await mkService(`${tag()} loose`, 4_000);
    const res = await createWith(
      [{ bundleId, startsAt }, { bundleId, startsAt }],
      [{ serviceId: loose, startsAt, addonIds: [], membershipId: null }],
    );

    expect(new Set(res.bundleInstanceIds).size).toBe(2);
    const items = await itemsOf(res.appointmentId);
    expect(items).toHaveLength(7); // 3 + 3 + 1

    for (const instId of res.bundleInstanceIds) {
      const sub = items.filter((i) => i.bundle_instance_id === instId);
      expect(sub).toHaveLength(3);
      expect(sub.reduce((n, i) => n + i.price_cents_snapshot, 0)).toBe(15_000);
    }
    const looseRow = items.find((i) => i.bundle_instance_id === null)!;
    expect(looseRow.service_id).toBe(loose);
    expect(looseRow.price_cents_snapshot).toBe(4_000);
  });

  it('manual extra discount ($20 off) lands on the instance and its sub-items', async () => {
    const bundleId = (await save(abc())).result.bundleId;
    const res = await createWith([{ bundleId, startsAt, extraDiscountCents: 2_000 }]);
    const items = await itemsOf(res.appointmentId);
    expect(items.reduce((n, i) => n + i.price_cents_snapshot, 0)).toBe(13_000);
    const inst = await instancesOf(res.appointmentId);
    expect(inst[0]!.extra_discount_cents).toBe(2_000);
  });

  it('extra add-on on a bundle unit folds into that unit snapshot + addon_ids', async () => {
    const bundleId = (await save(abc())).result.bundleId;
    const q = await withTenant(NAIL, (tx) => quoteBundle(tx, { locationId: NAIL.locationId }, {
      bundleId, extraAddons: [], extraDiscountCents: 0, extraDiscountKind: 'manual',
    } as any));
    const unitKey = q.units[1]!.unitKey; // attach to B
    const res = await createWith([{
      bundleId, startsAt,
      extraAddons: [{ ref: 'a1', attachToUnit: unitKey, serviceId: ADDON, qty: 1 }],
    }]);
    const items = await itemsOf(res.appointmentId);
    const withAddon = items.find((i) => i.addon_ids.includes(ADDON))!;
    expect(withAddon).toBeTruthy();
    // 该单元快照 = 套餐净额份额 + 加项净额；全部子项 + 加项 = 16500
    expect(items.reduce((n, i) => n + i.price_cents_snapshot, 0)).toBe(16_500);
  });

  it('version mismatch fails the whole create', async () => {
    const bundleId = (await save(abc())).result.bundleId;
    await expect(createWith([{ bundleId, startsAt, expectedVersion: 999 }]))
      .rejects.toMatchObject({ details: { reason: 'bundle_version_conflict' } });
    const any = await withTenant(NAIL, (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from order_bundle_instances where bundle_id = ${bundleId}`);
    expect(any[0]!.n).toBe(0); // 事务回滚，没留半份
  });
});

describe('ticket.open inherits the bundle instance (P3b)', () => {
  it('carries the same instance to the ticket and links ticket_items', async () => {
    const bundleId = (await save(abc())).result.bundleId;
    // 今天营业日内的预约（override 绕过营业时间闸门）。
    const startsAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const appt = await dispatch<{ appointmentId: string; bundleInstanceIds: string[] }>(
      'appointment.create',
      {
        customerId: null, walkInName: 'U10 open', items: [],
        bundleSelections: [{
          bundleId, startsAt,
          unitOverrides: [{ membershipId: staffId }, { membershipId: staffId }, { membershipId: staffId }],
        }],
        source: 'desk', override: { reason: 'desk_coordination' },
      },
      ctx, { idempotencyKey: randomUUID() },
    ).then((r) => r.result);

    const instanceId = appt.bundleInstanceIds[0]!;

    const opened = await dispatch<{ ticketId: string; ticketItemIds: string[]; subtotalCents: number }>(
      'ticket.open',
      {
        appointmentId: appt.appointmentId,
        customerId: null,
        items: [A, B, C].map((serviceId) => ({ serviceId, membershipId: staffId })),
      },
      ctx, { idempotencyKey: randomUUID() },
    ).then((r) => r.result);

    expect(opened.subtotalCents).toBe(15_000);

    // 同一实例身份，只是补了 ticket_id
    const inst = await withTenant(NAIL, (tx) => tx<{ id: string; appointment_id: string; ticket_id: string }[]>`
      select id, appointment_id, ticket_id from order_bundle_instances where id = ${instanceId}`);
    expect(inst[0]).toMatchObject({ appointment_id: appt.appointmentId, ticket_id: opened.ticketId });

    const titems = await withTenant(NAIL, (tx) => tx<{
      total_cents: number; bundle_instance_id: string | null;
      bundle_component_id: string | null; bundle_unit_index: number | null; bundle_list_price_cents: number | null;
    }[]>`select total_cents, bundle_instance_id, bundle_component_id, bundle_unit_index, bundle_list_price_cents
       from ticket_items where ticket_id = ${opened.ticketId} order by seq`);
    expect(titems).toHaveLength(3);
    expect(titems.every((t) => t.bundle_instance_id === instanceId)).toBe(true);
    expect(new Set(titems.map((t) => t.bundle_component_id)).size).toBe(3);
    expect(titems.every((t) => t.bundle_list_price_cents != null)).toBe(true);
    expect(titems.reduce((n, t) => n + t.total_cents, 0)).toBe(15_000);
  });
});
