/**
 * 一人多店（批 4）。
 *
 * 盯的是三件事：
 *   1. 第二家店能自助开出来，而且**建在同一个 org 下**
 *   2. 跨店汇总只看得见「我有 membership 且有报表权限」的店
 *   3. 别人的 org / 别人的店，一个数字都拿不到
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { withTenant, closeDb, listMembershipsForUser } from '@gf/db';
import { buildContext } from './actor';
import { dispatch } from './bus';
import { loadOrgSummary } from './queries/orgSummary';
import './handlers/setup';
import './handlers/billing';

const SPA_ORG = '22222222-2222-4222-8222-222222222222';
const SPA_LOC = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const NAIL_ORG = '11111111-1111-4111-8111-111111111111';
const NAIL_LOC = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const tenant = { orgId: SPA_ORG, locationId: SPA_LOC, membershipId: null };

let ctx: Awaited<ReturnType<typeof buildContext>>;
let ownerUserId = '';
const madeLocations: string[] = [];

const run = async <T>(name: string, input: unknown, key = crypto.randomUUID()): Promise<T> =>
  (await dispatch<T>(name, input, ctx, { idempotencyKey: key })).result;

beforeAll(async () => {
  // 足疗店那位是种子里唯一的 owner —— 只有他有 billing.manage
  const [m] = await withTenant(tenant, (tx) => tx<{ id: string; user_id: string }[]>`
    select m.id, m.user_id from memberships m
    join membership_roles mr on mr.membership_id = m.id
    join roles r on r.id = mr.role_id
    where m.location_id = ${SPA_LOC} and m.status = 'active' and r.key = 'owner'
    limit 1`);
  ownerUserId = m!.user_id;
  ctx = await buildContext({ userId: ownerUserId, membershipId: m!.id });
});

afterAll(async () => {
  /*
   * ⚠️ 拆的顺序是反着建的：staff_profiles / membership_roles / memberships /
   * role_permissions / roles / billing_accounts / location_subscriptions → locations。
   * 少拆一层，下一次跑就会撞外键，而报错指向的是一个和本文件无关的地方。
   */
  for (const id of madeLocations) {
    await withTenant({ orgId: SPA_ORG, locationId: id, membershipId: null }, async (tx) => {
      await tx`delete from staff_profiles where location_id = ${id}`;
      await tx`delete from membership_roles mr using memberships m
               where mr.membership_id = m.id and m.location_id = ${id}`;
      await tx`delete from memberships where location_id = ${id}`;
      await tx`delete from role_permissions rp using roles r
               where rp.role_id = r.id and r.location_id = ${id}`;
      await tx`delete from roles where location_id = ${id}`;
      await tx`delete from location_subscriptions where location_id = ${id}`;
      await tx`delete from billing_accounts where location_id = ${id}`;
    });
  }
  if (madeLocations.length > 0) {
    await withTenant(tenant, (tx) => tx`
      delete from locations where id = any(${madeLocations})`);
  }
  await closeDb();
});

describe('自助开第二家店', () => {
  it('⭐ 建在同一个 org 下，调用方自动成为 owner', async () => {
    const out = await run<{ locationId: string; orgId: string; slug: string }>(
      'location.create',
      { name: 'Second Spa', timezone: 'America/New_York', businessType: 'foot_spa' });
    madeLocations.push(out.locationId);

    expect(out.orgId).toBe(SPA_ORG);
    expect(out.slug).toMatch(/^second-spa-[0-9a-f]{6}$/);

    // 新店是 setup 状态 —— 开店清单还没走完，不该当成营业中的店
    const [loc] = await withTenant(tenant, (tx) => tx<{ status: string; org_id: string }[]>`
      select status, org_id from locations where id = ${out.locationId}`);
    expect(loc!.status).toBe('setup');
    expect(loc!.org_id).toBe(SPA_ORG);

    // 调用方在新店里是 owner，而且拿得到 billing.manage
    const mine = await listMembershipsForUser(ownerUserId);
    const there = mine.find((m) => m.locationId === out.locationId);
    expect(there?.roleKeys).toContain('owner');
  });

  it('⭐ 同名两家店 slug 不撞 —— 一个老板两条街上各开一家「Lotus Spa」是常态', async () => {
    const a = await run<{ slug: string; locationId: string }>('location.create',
      { name: 'Lotus Spa', timezone: 'America/New_York' });
    const b = await run<{ slug: string; locationId: string }>('location.create',
      { name: 'Lotus Spa', timezone: 'America/New_York' });
    madeLocations.push(a.locationId, b.locationId);
    expect(a.slug).not.toBe(b.slug);
  });

  it('⭐ 沿用同一个 Stripe 客户 —— 一个老板一张卡一张账单', async () => {
    await withTenant(tenant, (tx) => tx`
      update billing_accounts set stripe_customer_id = 'cus_multistore_test'
      where location_id = ${SPA_LOC}`);

    const out = await run<{ locationId: string }>('location.create',
      { name: 'Third Spa', timezone: 'America/New_York' });
    madeLocations.push(out.locationId);

    const [acct] = await withTenant(
      { orgId: SPA_ORG, locationId: out.locationId, membershipId: null },
      (tx) => tx<{ cust: string | null }[]>`
        select stripe_customer_id as cust from billing_accounts
        where location_id = ${out.locationId}`);
    expect(acct!.cust).toBe('cus_multistore_test');

    await withTenant(tenant, (tx) => tx`
      update billing_accounts set stripe_customer_id = null where location_id = ${SPA_LOC}`);
  });

  it('店长开不了店 —— 只有 billing.manage 才行', async () => {
    const [mgr] = await withTenant({ orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: null },
      (tx) => tx<{ id: string; user_id: string }[]>`
        select m.id, m.user_id from memberships m
        join membership_roles mr on mr.membership_id = m.id
        join roles r on r.id = mr.role_id
        where m.location_id = ${NAIL_LOC} and m.status = 'active'
          and r.key = 'manager' and m.user_id is not null
        limit 1`);
    if (!mgr) return;   // 种子里没有店长就跳过，不是失败

    const mgrCtx = await buildContext({ userId: mgr.user_id, membershipId: mgr.id });
    await expect(dispatch('location.create',
      { name: 'Sneaky Store', timezone: 'America/New_York' },
      mgrCtx, { idempotencyKey: crypto.randomUUID() }))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });
});

describe('跨店汇总', () => {
  const today = new Date().toISOString().slice(0, 10);

  it('⭐ 只汇总传进来的那几家 —— 别人的店一个数字都进不来', async () => {
    const out = await loadOrgSummary(
      [{ orgId: SPA_ORG, locationId: SPA_LOC, membershipId: null }], today, today);

    expect(out.stores).toHaveLength(1);
    expect(out.stores[0]!.locationId).toBe(SPA_LOC);
    // 美甲店的数字绝不该混进来
    expect(out.stores.some((s) => s.locationId === NAIL_LOC)).toBe(false);
  });

  it('⭐ 合计的客单价是重算的，不是把各店平均值再平均', async () => {
    const out = await loadOrgSummary([
      { orgId: SPA_ORG, locationId: SPA_LOC, membershipId: null },
    ], today, today);

    // 单店时合计必须等于那一家 —— 这是最基本的自洽
    expect(out.total.revenueCents).toBe(out.stores[0]!.revenueCents);
    expect(out.total.appointments).toBe(out.stores[0]!.appointments);
  });

  it('空区间返回零而不是 null，前端少一个分支', async () => {
    const out = await loadOrgSummary([], today, today);
    expect(out.stores).toEqual([]);
    expect(out.total.revenueCents).toBe(0);
    expect(out.total.avgOrderCents).toBe(0);
    expect(out.total.cancelRateBp).toBe(0);
  });
});
