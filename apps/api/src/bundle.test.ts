/**
 * U10 组合套餐目录 handler：saveTemplate / archiveTemplate / quote。
 * 隔离库集成测试（DATABASE_TEST_TARGET=isolated）。
 */

import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { withTenant, closeDb } from '@gf/db';
import { buildContext } from './actor';
import { dispatch } from './bus';
import { quoteBundle } from './queries/bundle';
import './handlers/setup';
import './handlers/bundle';

const NAIL = { orgId: '11111111-1111-4111-8111-111111111111', locationId: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', membershipId: null };
const SPA = { orgId: '22222222-2222-4222-8222-222222222222', locationId: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', membershipId: null };

let ctx: Awaited<ReturnType<typeof buildContext>>;
let A: string; let B: string; let C: string; let ADDON: string;

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
    const q = await quote({ extraAddons: [{ ref: 'x1', attachToUnit: 'unit', serviceId: ADDON, qty: 1 }] });
    expect(q.extraAddonListTotalCents).toBe(1_500);
    expect(q.serviceNetTotalCents).toBe(16_500);
    expect(q.extraAddons[0]!.netCents).toBe(1_500);
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
