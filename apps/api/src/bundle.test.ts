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
import { scanLegacyPackageCandidates } from './queries/bundleMigration';
import './handlers/setup';
import './handlers/bundle';
import './handlers/appointment';
import './handlers/ticket';
import './handlers/marketing';
import './handlers/kiosk';
import { loadQueue } from './queries/queue';

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

describe('bundle-aware reschedule / cancel (P3c)', () => {
  const startsAt = new Date(Date.now() + 26 * 60 * 60 * 1000).toISOString();
  const createOne = async () => {
    const bundleId = (await save(abc())).result.bundleId;
    const res = await dispatch<{ appointmentId: string; bundleInstanceIds: string[] }>(
      'appointment.create',
      {
        customerId: null, walkInName: 'U10 p3c', items: [],
        bundleSelections: [{ bundleId, startsAt }],
        source: 'desk', override: { reason: 'desk_coordination' },
      },
      ctx, { idempotencyKey: randomUUID() },
    ).then((r) => r.result);
    return res;
  };
  const items = (appointmentId: string) => withTenant(NAIL, (tx) => tx<{
    id: string; starts_at: string; bundle_instance_id: string | null; seq: number;
  }[]>`select id, starts_at, bundle_instance_id, seq from appointment_items
       where appointment_id = ${appointmentId} order by seq`);

  it('rescheduling one bundle sub-item moves the whole instance, keeping offsets', async () => {
    const res = await createOne();
    const before = await items(res.appointmentId);
    const gap01 = new Date(before[1]!.starts_at).getTime() - new Date(before[0]!.starts_at).getTime();

    const newStart = new Date(Date.now() + 50 * 60 * 60 * 1000).toISOString();
    await dispatch('appointment.reschedule', {
      appointmentId: res.appointmentId, itemId: before[0]!.id, startsAt: newStart,
      override: { reason: 'desk_coordination' },
    }, ctx, { idempotencyKey: randomUUID() });

    const after = await items(res.appointmentId);
    expect(new Date(after[0]!.starts_at).toISOString()).toBe(new Date(newStart).toISOString());
    // 三个子项一起挪，相对间隔不变
    expect(new Date(after[1]!.starts_at).getTime() - new Date(after[0]!.starts_at).getTime()).toBe(gap01);
    expect(new Date(after[2]!.starts_at).getTime()).toBeGreaterThan(new Date(after[1]!.starts_at).getTime());
  });

  it('cancelling the appointment marks the bundle instance cancelled', async () => {
    const res = await createOne();
    await dispatch('appointment.cancel', {
      appointmentId: res.appointmentId, reason: 'input_error', keepStaffTurn: false,
    }, ctx, { idempotencyKey: randomUUID() });
    const instId = res.bundleInstanceIds[0]!;
    const inst = await withTenant(NAIL, (tx) => tx<{ status: string }[]>`
      select status from order_bundle_instances where id = ${instId}`);
    expect(inst[0]!.status).toBe('cancelled');
  });
});

describe('queue view carries bundle grouping (P4)', () => {
  it('walk-in queue entry exposes bundles[] + per-item bundle linkage', async () => {
    const bundleId = (await save(abc())).result.bundleId;
    const startsAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const appt = await dispatch<{ appointmentId: string; bundleInstanceIds: string[]; businessDate: string }>(
      'appointment.create',
      {
        customerId: null, walkInName: 'U10 p4', items: [],
        bundleSelections: [{ bundleId, startsAt }],
        source: 'desk', override: { reason: 'desk_coordination' },
      },
      ctx, { idempotencyKey: randomUUID() },
    ).then((r) => r.result);

    await dispatch('queue.join', {
      appointmentId: appt.appointmentId, source: 'desk',
    }, ctx, { idempotencyKey: randomUUID() });

    const q = await withTenant(NAIL, (tx) => loadQueue(tx, ctx, appt.businessDate));
    const entry = [...q.waiting, ...q.called, ...q.seated]
      .find((e) => e.appointmentId === appt.appointmentId);
    expect(entry).toBeTruthy();
    expect(entry!.bundles).toHaveLength(1);
    expect(entry!.bundles![0]).toMatchObject({
      instanceId: appt.bundleInstanceIds[0], bundlePriceCents: 15_000, unitCount: 3,
    });
    expect(entry!.items!.every((i) => i.bundleInstanceId === appt.bundleInstanceIds[0])).toBe(true);
    expect(new Set(entry!.items!.map((i) => i.bundleComponentId)).size).toBe(3);
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

// ─────────────────────────────────────────────────────────────────── P5
//
// 结账 / 退款 / 提成对组合套餐安全（计划 §4.5 / §6，验收 B17 / B23 / B25 / B29）。
// 关注点：套餐子项 total_cents 已是分摊后净额 —— 结账不得再叠一层优惠，
// 提成基数按分摊实售额而非目录原价，次卡不核销套餐子项，退款按原提成冲销。

describe('P5 结账 / 退款 / 提成对组合套餐安全', () => {
  // NAIL 种子税率 8.875%（exclusive）：15000 净额对应税额 1331。
  const TAX_ON_15000 = Math.round(15_000 * 0.08875);

  const mkCustomer = () => withTenant(NAIL, (tx) => tx<{ id: string }[]>`
    insert into customers (org_id, primary_location_id, display_name, phone_e164)
    values (${NAIL.orgId}, ${NAIL.locationId}, 'U10 P5 客户',
            ${`+1617${Math.floor(1_000_000 + Math.random() * 9_000_000)}`})
    returning id`).then((r) => r[0]!.id);

  /** 建套餐 → 预约（今日）→ 开单，返回一张待结账的组合套餐工单。 */
  async function openBundleTicket(opts: {
    customerId?: string | null; looseServiceIds?: string[];
  } = {}) {
    const customerId = opts.customerId ?? null;
    const loose = opts.looseServiceIds ?? [];
    const bundleId = (await save(abc())).result.bundleId;
    const startsAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const appt = await dispatch<{ appointmentId: string; bundleInstanceIds: string[] }>(
      'appointment.create',
      {
        customerId,
        ...(customerId ? {} : { walkInName: 'U10 P5' }),
        items: loose.map((serviceId) => ({
          serviceId, startsAt, addonIds: [], membershipId: staffId,
        })),
        bundleSelections: [{
          bundleId, startsAt,
          unitOverrides: [{ membershipId: staffId }, { membershipId: staffId }, { membershipId: staffId }],
        }],
        source: 'desk', override: { reason: 'desk_coordination' },
      },
      ctx, { idempotencyKey: randomUUID() },
    ).then((r) => r.result);

    // 预约子项顺序：散项在前（seq 0..），套餐执行单元在后。
    const opened = await dispatch<{ ticketId: string; subtotalCents: number }>(
      'ticket.open',
      {
        appointmentId: appt.appointmentId, customerId,
        items: [...loose, A, B, C].map((serviceId) => ({ serviceId, membershipId: staffId })),
      },
      ctx, { idempotencyKey: randomUUID() },
    ).then((r) => r.result);
    return { ...opened, bundleInstanceId: appt.bundleInstanceIds[0]! };
  }

  const commissionOf = (ticketId: string) => withTenant(NAIL, (tx) => tx<{
    amount: number; base: number;
  }[]>`select coalesce(sum(amount_cents), 0)::int as amount,
              coalesce(sum(base_cents), 0)::int as base
       from earnings where ticket_id = ${ticketId} and kind = 'commission'`).then((r) => r[0]!);

  it('结账：收款额 = 分摊净额 + 税，提成基数按分摊实售额（B25 / B29）', async () => {
    const { ticketId, subtotalCents } = await openBundleTicket();
    expect(subtotalCents).toBe(15_000);

    await dispatch('ticket.close', {
      ticketId,
      payments: [{
        method: 'cash', amountCents: 15_000 + TAX_ON_15000, tipCents: 0,
        tenderedCents: 15_000 + TAX_ON_15000,
      }],
    }, ctx, { idempotencyKey: randomUUID() });

    const [t] = await withTenant(NAIL, (tx) => tx<{
      status: string; subtotal_cents: number; total_cents: number;
      discount_cents: number; tax_cents: number;
    }[]>`select status, subtotal_cents, total_cents, discount_cents, tax_cents
         from tickets where id = ${ticketId}`);
    expect(t).toMatchObject({
      status: 'closed', subtotal_cents: 15_000, discount_cents: 0,
      tax_cents: TAX_ON_15000, total_cents: 15_000 + TAX_ON_15000,
    });

    // 提成基数 = 分摊实售额 15000，不是目录原价 17000，也没有第 4 行父套餐收款。
    const commission = await commissionOf(ticketId);
    expect(commission.base).toBe(15_000);

    const [rows] = await withTenant(NAIL, (tx) => tx<{ n: number; sum: number }[]>`
      select count(*)::int as n, coalesce(sum(total_cents), 0)::int as sum
      from ticket_items where ticket_id = ${ticketId}`);
    expect(rows).toEqual({ n: 3, sum: 15_000 });
  });

  it('次卡：只核销散项，不覆盖套餐子项（B17）', async () => {
    const customerId = await mkCustomer();
    const loose = await mkService(`${tag()} loose-svc`, 4_000);
    const template = await dispatch<{ templateId: string }>(
      'package.saveTemplate',
      { name: `${tag()} 单项次卡`, priceCents: 6_000, sessions: 2, serviceIds: [loose] },
      ctx,
    ).then((r) => r.result);
    const issued = await dispatch<{ packageId: string }>(
      'package.issue', { templateId: template.templateId, customerId }, ctx,
      { idempotencyKey: randomUUID() },
    ).then((r) => r.result);

    const { ticketId } = await openBundleTicket({ customerId, looseServiceIds: [loose] });

    // subtotal = 15000 套餐 + 4000 散项；次卡核销 4000（仅散项）；税基 15000。
    await dispatch('ticket.pay', {
      ticketId,
      payments: [{
        method: 'cash', amountCents: 15_000 + TAX_ON_15000, tipCents: 0,
        tenderedCents: 15_000 + TAX_ON_15000,
      }],
      packageRedemptions: [{ customerPackageId: issued.packageId, units: 1 }],
    }, ctx, { idempotencyKey: randomUUID() });

    const looseItemId = await withTenant(NAIL, (tx) => tx<{ id: string }[]>`
      select id from ticket_items where ticket_id = ${ticketId} and service_id = ${loose}`)
      .then((r) => r[0]!.id);

    const [redeem] = await withTenant(NAIL, (tx) => tx<{
      covered: number; item_ids: string[];
    }[]>`select (meta->>'coveredCents')::int as covered,
                array(select jsonb_array_elements_text(meta->'ticketItemIds')) as item_ids
         from customer_credit_ledger
         where kind = 'package' and subject_id = ${issued.packageId}
           and entry = 'redeem' and ticket_id = ${ticketId}`);
    // 只覆盖散项：金额 = 散项净价，命中 item 只有散项那一行。
    expect(redeem!.covered).toBe(4_000);
    expect(redeem!.item_ids).toEqual([looseItemId]);

    // 套餐三个子项净额分文未动。
    const [bundleItems] = await withTenant(NAIL, (tx) => tx<{ n: number; sum: number }[]>`
      select count(*)::int as n, coalesce(sum(total_cents), 0)::int as sum
      from ticket_items where ticket_id = ${ticketId} and bundle_instance_id is not null`);
    expect(bundleItems).toEqual({ n: 3, sum: 15_000 });
  });

  it('次卡：service_id 命中的仅是套餐子项时，核销被拒（不二次全额覆盖，§4.5）', async () => {
    const customerId = await mkCustomer();
    const template = await dispatch<{ templateId: string }>(
      'package.saveTemplate',
      { name: `${tag()} 命中子项次卡`, priceCents: 6_000, sessions: 2, serviceIds: [A] },
      ctx,
    ).then((r) => r.result);
    const issued = await dispatch<{ packageId: string }>(
      'package.issue', { templateId: template.templateId, customerId }, ctx,
      { idempotencyKey: randomUUID() },
    ).then((r) => r.result);

    const { ticketId } = await openBundleTicket({ customerId });

    await expect(dispatch('ticket.pay', {
      ticketId,
      payments: [{
        method: 'cash', amountCents: 15_000 + TAX_ON_15000, tipCents: 0,
        tenderedCents: 15_000 + TAX_ON_15000,
      }],
      packageRedemptions: [{ customerPackageId: issued.packageId, units: 1 }],
    }, ctx, { idempotencyKey: randomUUID() }))
      .rejects.toMatchObject({ details: { reason: 'package_services_not_on_ticket' } });

    const [pkg] = await withTenant(NAIL, (tx) => tx<{ remaining_sessions: number }[]>`
      select remaining_sessions from customer_packages where id = ${issued.packageId}`);
    expect(pkg!.remaining_sessions).toBe(2); // 整笔回滚，未扣次
  });

  it('全额退款：提成按原政策冲销，父子不重复（B23）', async () => {
    const { ticketId } = await openBundleTicket();
    await dispatch('ticket.close', {
      ticketId,
      payments: [{
        method: 'cash', amountCents: 15_000 + TAX_ON_15000, tipCents: 0,
        tenderedCents: 15_000 + TAX_ON_15000,
      }],
    }, ctx, { idempotencyKey: randomUUID() });

    const before = await commissionOf(ticketId);
    expect(before.base).toBe(15_000);

    await dispatch('ticket.refund', {
      ticketId, refundAmountCents: 15_000 + TAX_ON_15000, refundTipCents: 0,
      reason: 'wrong_charge', refundMethod: 'original_payment',
    }, ctx, { idempotencyKey: randomUUID() });

    const [t] = await withTenant(NAIL, (tx) => tx<{ status: string }[]>`
      select status from tickets where id = ${ticketId}`);
    expect(t!.status).toBe('refunded');

    // 原提成 + 冲销 = 0：按分摊净额 15000 整额冲回，没有多冲（父套餐无独立收款行）。
    const after = await commissionOf(ticketId);
    expect(after).toEqual({ amount: 0, base: 0 });
  });
});

// ─────────────────────────────────────────────────────────────────── P7
//
// 历史 package_templates 的组合套餐候选扫描（计划 §7）——只读，只给建议。
describe('P7 历史次卡候选扫描', () => {
  const savePkg = (input: Record<string, unknown>) =>
    dispatch<{ templateId: string }>('package.saveTemplate', input, ctx)
      .then((r) => r.result.templateId);

  it('按「去重项目数 + 次数」分类，默认不列纯次卡', async () => {
    const combo = await savePkg({
      name: `${tag()} 三选一组合`, priceCents: 12_000, sessions: 1, serviceIds: [A, B, C],
    });
    const ambiguous = await savePkg({
      name: `${tag()} 说不清`, priceCents: 9_000, sessions: 5, serviceIds: [A, B],
    });
    const punch = await savePkg({
      name: `${tag()} 十次卡`, priceCents: 8_000, sessions: 10, serviceIds: [A],
    });

    const scan = await withTenant(NAIL, (tx) => scanLegacyPackageCandidates(tx, ctx));
    const mine = new Map(scan.candidates.map((c) => [c.templateId, c]));

    expect(mine.get(combo)?.classification).toBe('likely_bundle');
    expect(mine.get(ambiguous)?.classification).toBe('ambiguous');
    // 纯次卡默认不出现在候选里
    expect(mine.has(punch)).toBe(false);
    // 只读：不建任何 service_bundles 行
    const [n] = await withTenant(NAIL, (tx) => tx<{ c: number }[]>`
      select count(*)::int as c from service_bundles where name->>'en' like '%三选一组合%'`);
    expect(n!.c).toBe(0);

    const scanAll = await withTenant(NAIL, (tx) =>
      scanLegacyPackageCandidates(tx, ctx, { includePunchcards: true }));
    expect(scanAll.candidates.find((c) => c.templateId === punch)?.classification)
      .toBe('likely_punchcard');
  });
});

// ─────────────────────────────────────────────────────────── walk-in 直接开单
//
// 直接 ticket.open 选组合套餐（U10 / 计划 §7）——不经预约，展开由服务端
// quoteBundle 完成，建 ticket 归属的 order_bundle_instances。
describe('ticket.open 直接选组合套餐（walk-in）', () => {
  const openWalkIn = (bundleSelections: unknown[], extra: Record<string, unknown> = {}) =>
    dispatch<{ ticketId: string; ticketItemIds: string[]; bundleInstanceIds: string[]; subtotalCents: number }>(
      'ticket.open',
      { customerId: null, walkInName: 'U10 walk-in', items: [], bundleSelections, ...extra },
      ctx, { idempotencyKey: randomUUID() },
    ).then((r) => r.result);

  it('展开成子项、建 ticket 归属的实例、金额 = 组合价', async () => {
    const bundleId = (await save(abc())).result.bundleId;
    const res = await openWalkIn([{
      bundleId,
      unitOverrides: [{ membershipId: staffId }, { membershipId: staffId }, { membershipId: staffId }],
    }]);
    expect(res.bundleInstanceIds).toHaveLength(1);
    expect(res.subtotalCents).toBe(15_000);
    expect(res.ticketItemIds).toHaveLength(3);

    const [inst] = await withTenant(NAIL, (tx) => tx<{
      appointment_id: string | null; ticket_id: string | null;
      bundle_price_cents: number; discount_cents: number; source: string; status: string;
    }[]>`select appointment_id, ticket_id, bundle_price_cents, discount_cents, source, status
         from order_bundle_instances where id = ${res.bundleInstanceIds[0]!}`);
    expect(inst).toMatchObject({
      appointment_id: null, ticket_id: res.ticketId, bundle_price_cents: 15_000,
      discount_cents: 2_000, source: 'walk_in', status: 'active',
    });

    const items = await withTenant(NAIL, (tx) => tx<{
      total_cents: number; bundle_instance_id: string | null; bundle_component_id: string | null;
      bundle_list_price_cents: number | null;
    }[]>`select total_cents, bundle_instance_id, bundle_component_id, bundle_list_price_cents
         from ticket_items where ticket_id = ${res.ticketId} order by seq`);
    expect(items).toHaveLength(3);
    expect(items.every((i) => i.bundle_instance_id === res.bundleInstanceIds[0])).toBe(true);
    expect(new Set(items.map((i) => i.bundle_component_id)).size).toBe(3);
    expect(items.every((i) => i.bundle_list_price_cents != null)).toBe(true);
    expect(items.reduce((n, i) => n + i.total_cents, 0)).toBe(15_000);
  });

  it('结账走通：收款 = 分摊净额 + 税（B26 walk-in 与前台同口径）', async () => {
    const bundleId = (await save(abc())).result.bundleId;
    const { ticketId } = await openWalkIn([{
      bundleId,
      unitOverrides: [{ membershipId: staffId }, { membershipId: staffId }, { membershipId: staffId }],
    }]);
    const tax = Math.round(15_000 * 0.08875);
    await dispatch('ticket.close', {
      ticketId,
      payments: [{ method: 'cash', amountCents: 15_000 + tax, tipCents: 0, tenderedCents: 15_000 + tax }],
    }, ctx, { idempotencyKey: randomUUID() });
    const [t] = await withTenant(NAIL, (tx) => tx<{ status: string; total_cents: number; tax_cents: number }[]>`
      select status, total_cents, tax_cents from tickets where id = ${ticketId}`);
    expect(t).toMatchObject({ status: 'closed', total_cents: 15_000 + tax, tax_cents: tax });
  });

  it('与 appointmentId 互斥', async () => {
    const bundleId = (await save(abc())).result.bundleId;
    await expect(openWalkIn(
      [{ bundleId, unitOverrides: [{ membershipId: staffId }, { membershipId: staffId }, { membershipId: staffId }] }],
      { appointmentId: randomUUID(), items: [{ serviceId: A, membershipId: staffId }] },
    )).rejects.toMatchObject({ details: { reason: 'bundle_selection_not_allowed_with_appointment' } });
  });

  it('unitOverrides 少于执行单元数 → 拒绝', async () => {
    const bundleId = (await save(abc())).result.bundleId;
    await expect(openWalkIn([{ bundleId, unitOverrides: [{ membershipId: staffId }] }]))
      .rejects.toMatchObject({ details: { reason: 'bundle_unit_staff_required' } });
  });
});

// ─────────────────────────────────────────────────────────── 拆单为单项（B14）
describe('bundle.splitInstance 拆单为单项', () => {
  const overrides = () => [{ membershipId: staffId }, { membershipId: staffId }, { membershipId: staffId }];
  const openWalkIn = (sel: Record<string, unknown>) =>
    dispatch<{ ticketId: string; bundleInstanceIds: string[] }>(
      'ticket.open',
      { customerId: null, walkInName: 'U10 split', items: [], bundleSelections: [sel] },
      ctx, { idempotencyKey: randomUUID() },
    ).then((r) => r.result);
  const split = (ticketId: string, bundleInstanceId: string) =>
    dispatch<{ splitItemCount: number; subtotalCents: number }>(
      'bundle.splitInstance', { ticketId, bundleInstanceId }, ctx, { idempotencyKey: randomUUID() },
    ).then((r) => r.result);

  it('未开工未付款：恢复锁定单项原价，实例置 split，subtotal = 原价合计', async () => {
    const bundleId = (await save(abc())).result.bundleId;
    const { ticketId, bundleInstanceIds } = await openWalkIn({ bundleId, unitOverrides: overrides() });
    const res = await split(ticketId, bundleInstanceIds[0]!);
    expect(res).toMatchObject({ splitItemCount: 3, subtotalCents: 17_000 });

    const items = await withTenant(NAIL, (tx) => tx<{
      total_cents: number; bundle_instance_id: string | null; bundle_component_id: string | null;
    }[]>`select total_cents, bundle_instance_id, bundle_component_id
         from ticket_items where ticket_id = ${ticketId} order by seq`);
    expect(items.map((i) => i.total_cents).sort((a, b) => a - b)).toEqual([2_000, 5_000, 10_000]);
    expect(items.every((i) => i.bundle_instance_id === null && i.bundle_component_id === null)).toBe(true);

    const [inst] = await withTenant(NAIL, (tx) => tx<{ status: string }[]>`
      select status from order_bundle_instances where id = ${bundleInstanceIds[0]!}`);
    expect(inst!.status).toBe('split');

    const [t] = await withTenant(NAIL, (tx) => tx<{ subtotal_cents: number; total_cents: number }[]>`
      select subtotal_cents, total_cents from tickets where id = ${ticketId}`);
    expect(t).toMatchObject({ subtotal_cents: 17_000, total_cents: 17_000 });
  });

  it('二次拆同一实例 → bundle_instance_not_active', async () => {
    const bundleId = (await save(abc())).result.bundleId;
    const { ticketId, bundleInstanceIds } = await openWalkIn({ bundleId, unitOverrides: overrides() });
    await split(ticketId, bundleInstanceIds[0]!);
    await expect(split(ticketId, bundleInstanceIds[0]!))
      .rejects.toMatchObject({ details: { reason: 'bundle_instance_not_active' } });
  });

  it('带额外优惠的实例暂不支持拆单', async () => {
    const bundleId = (await save(abc())).result.bundleId;
    const { ticketId, bundleInstanceIds } = await openWalkIn({
      bundleId, unitOverrides: overrides(), extraDiscountCents: 2_000,
    });
    await expect(split(ticketId, bundleInstanceIds[0]!))
      .rejects.toMatchObject({ details: { reason: 'bundle_split_with_extras_unsupported' } });
  });

  it('已结账工单不能拆', async () => {
    const bundleId = (await save(abc())).result.bundleId;
    const { ticketId, bundleInstanceIds } = await openWalkIn({ bundleId, unitOverrides: overrides() });
    const tax = Math.round(15_000 * 0.08875);
    await dispatch('ticket.close', {
      ticketId,
      payments: [{ method: 'cash', amountCents: 15_000 + tax, tipCents: 0, tenderedCents: 15_000 + tax }],
    }, ctx, { idempotencyKey: randomUUID() });
    await expect(split(ticketId, bundleInstanceIds[0]!))
      .rejects.toMatchObject({ details: { reason: 'bundle_split_ticket_not_open' } });
  });
});
