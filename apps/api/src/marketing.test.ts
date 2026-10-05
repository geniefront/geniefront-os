/**
 * 营销体系测试（P1 次卡套餐 / 优惠券 / 积分 / 礼品卡列表）
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { withTenant, closeDb } from '@gf/db';
import { buildContext } from './actor';
import { dispatchWithCommerceSale as dispatch } from './test/commerceSaleDispatch';
import './handlers/marketing';
import './handlers/ticket';
import { loadPackages, loadCoupons, loadLoyalty } from './queries/marketing';
import { loadGiftCards } from './queries/giftcard';

const NAIL_ORG = '11111111-1111-4111-8111-111111111111';
const NAIL_LOC = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const tenant = { orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: null };

let ownerCtx: Awaited<ReturnType<typeof buildContext>>;
let customerId = '';
const cleanupPackageTemplateIds: string[] = [];
const cleanupCouponIds: string[] = [];

beforeAll(async () => {
  const [owner] = await withTenant(tenant, (tx) => tx<{ id: string; user_id: string }[]>`
    select m.id, m.user_id from memberships m
    join membership_roles mr on mr.membership_id = m.id
    join roles r on r.id = mr.role_id
    where m.location_id = ${NAIL_LOC} and m.status = 'active'
      and r.key in ('owner','manager') and m.user_id is not null limit 1`);
  ownerCtx = await buildContext({ userId: owner!.user_id, membershipId: owner!.id });

  const dynamicPhone = `+1617${Math.floor(1000000 + Math.random() * 9000000)}`;
  const [cust] = await withTenant(tenant, (tx) => tx<{ id: string }[]>`
    insert into customers (org_id, primary_location_id, display_name, phone_e164)
    values (${NAIL_ORG}, ${NAIL_LOC}, '营销测试客户', ${dynamicPhone})
    returning id`);
  customerId = cust!.id;
});

afterAll(async () => {
  // Paid purchase/quantity history is retained until the isolated database reset.
  for (const id of cleanupCouponIds) {
    await withTenant(tenant, (tx) => tx`delete from coupon_templates where id = ${id}`);
  }
  await closeDb();
});

describe('次卡套餐 (Packages)', () => {
  let templateId = '';
  let issuedPackageId = '';

  it('套餐模板绑定多个本店服务并返回完整项目名', async () => {
    const services = await withTenant(tenant, (tx) => tx<{ id: string; name: unknown }[]>`
      select id, name from services
      where location_id = ${NAIL_LOC} and active = true order by sort limit 2`);
    expect(services).toHaveLength(2);

    const res = await dispatch<{ templateId: string }>(
      'package.saveTemplate',
      {
        name: '双项目优惠组合',
        priceCents: 9900,
        sessions: 3,
        serviceIds: services.map((service) => service.id),
        validDays: 90,
      },
      ownerCtx,
    );
    cleanupPackageTemplateIds.push(res.result.templateId);

    const list = await withTenant(tenant, (tx) => loadPackages(tx, ownerCtx));
    const pkg = list.templates.find((item) => item.id === res.result.templateId);
    expect(pkg?.serviceIds).toEqual(services.map((service) => service.id));
    expect(pkg?.serviceNames).toHaveLength(2);
    expect(list.availableServices.length).toBeGreaterThanOrEqual(2);
  });

  it('套餐模板拒绝绑定不存在或非本店的服务', async () => {
    await expect(dispatch(
      'package.saveTemplate',
      {
        name: '非法组合', priceCents: 1000, sessions: 1,
        serviceIds: ['00000000-0000-4000-8000-000000000099'],
      },
      ownerCtx,
    )).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('绑定项目套餐只允许在同一顾客且项目齐全的服务单核销一次', async () => {
    const services = await withTenant(tenant, (tx) => tx<{ id: string }[]>`
      select id from services where location_id = ${NAIL_LOC} and active = true order by sort limit 2`);
    const template = await dispatch<{ templateId: string }>(
      'package.saveTemplate',
      { name: '核销校验组合', priceCents: 8800, sessions: 2, serviceIds: services.map((s) => s.id) },
      ownerCtx,
    );
    cleanupPackageTemplateIds.push(template.result.templateId);
    const issued = await dispatch<{ packageId: string }>(
      'package.issue', { templateId: template.result.templateId, customerId }, ownerCtx,
    );

    const [ticket] = await withTenant(tenant, (tx) => tx<{ id: string }[]>`
      insert into tickets (org_id, location_id, business_date, customer_id, status, opened_by)
      values (${NAIL_ORG}, ${NAIL_LOC}, current_date, ${customerId}, 'in_service', ${ownerCtx.membershipId})
      returning id`);
    await withTenant(tenant, (tx) => tx`
      insert into ticket_items
        (org_id, location_id, ticket_id, kind, service_id, name_snapshot,
         qty, unit_price_cents, total_cents, duration_min)
      values (${NAIL_ORG}, ${NAIL_LOC}, ${ticket!.id}, 'service', ${services[0]!.id},
              '套餐项目 A', 1, 5000, 5000, 30)`);

    await expect(dispatch(
      'package.redeem', { packageId: issued.result.packageId, customerId, ticketId: ticket!.id }, ownerCtx,
    )).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    await withTenant(tenant, (tx) => tx`
      insert into ticket_items
        (org_id, location_id, ticket_id, kind, service_id, name_snapshot,
         qty, unit_price_cents, total_cents, duration_min)
      values (${NAIL_ORG}, ${NAIL_LOC}, ${ticket!.id}, 'service', ${services[1]!.id},
              '套餐项目 B', 1, 5000, 5000, 30)`);
    const redeemed = await dispatch<{ remainingSessions: number }>(
      'package.redeem', { packageId: issued.result.packageId, customerId, ticketId: ticket!.id }, ownerCtx,
    );
    expect(redeemed.result.remainingSessions).toBe(1);

    await expect(dispatch(
      'package.redeem', { packageId: issued.result.packageId, customerId, ticketId: ticket!.id }, ownerCtx,
    )).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('结账内原子核销组合套餐，并按实收套餐价分摊提成基数', async () => {
    const services = await withTenant(tenant, (tx) => tx<{ id: string }[]>`
      select id from services where location_id = ${NAIL_LOC} and active = true order by sort limit 2`);
    const template = await dispatch<{ templateId: string }>(
      'package.saveTemplate',
      { name: '结账原子核销组合', priceCents: 8000, sessions: 2, serviceIds: services.map((s) => s.id) },
      ownerCtx,
    );
    cleanupPackageTemplateIds.push(template.result.templateId);
    const issued = await dispatch<{ packageId: string }>(
      'package.issue', { templateId: template.result.templateId, customerId }, ownerCtx,
    );
    const [oldLocation] = await withTenant(tenant, (tx) => tx<{ settings: Record<string, unknown> }[]>`
      select settings from locations where id = ${NAIL_LOC}`);
    const oldCheckout = JSON.stringify(oldLocation?.settings?.['checkout'] ?? {});
    await withTenant(tenant, (tx) => tx`update locations set settings = jsonb_set(
      settings, '{checkout}', coalesce(settings->'checkout', '{}'::jsonb)
        || '{"packageCoverageMode":"bundle","packageCommissionBasis":"allocated_sale_price"}'::jsonb, true)
      where id = ${NAIL_LOC}`);

    try {
      const [ticket] = await withTenant(tenant, (tx) => tx<{ id: string }[]>`
        insert into tickets (org_id, location_id, business_date, customer_id, status, opened_by,
                             subtotal_cents, total_cents, checkout_timing_snapshot)
        values (${NAIL_ORG}, ${NAIL_LOC}, current_date, ${customerId}, 'ready_to_pay',
                ${ownerCtx.membershipId}, 10000, 10000, 'after_service_combined') returning id`);
      const items = await withTenant(tenant, (tx) => tx<{ id: string }[]>`
        insert into ticket_items
          (org_id, location_id, ticket_id, kind, service_id, name_snapshot, qty,
           unit_price_cents, total_cents, duration_min, seq, started_at, finished_at)
        values
          (${NAIL_ORG}, ${NAIL_LOC}, ${ticket!.id}, 'service', ${services[0]!.id}, '项目 A', 1, 5000, 5000, 30, 0, now(), now()),
          (${NAIL_ORG}, ${NAIL_LOC}, ${ticket!.id}, 'service', ${services[1]!.id}, '项目 B', 1, 5000, 5000, 30, 1, now(), now())
        returning id`);
      for (const item of items) {
        await withTenant(tenant, (tx) => tx`insert into ticket_item_staff
          (org_id, ticket_item_id, membership_id, role, minutes)
          values (${NAIL_ORG}, ${item.id}, ${ownerCtx.membershipId}, 'primary', 30)`);
      }

      await expect(dispatch('ticket.pay', {
        ticketId: ticket!.id,
        payments: [{ method: 'card', amountCents: 1, tipCents: 0 }],
        packageRedemptions: [{ customerPackageId: issued.result.packageId, units: 1 }],
      }, ownerCtx, { idempotencyKey: `${issued.result.packageId}-bad` })).rejects.toMatchObject({ code: 'PAYMENT_MISMATCH' });
      const [afterFailed] = await withTenant(tenant, (tx) => tx<{ remaining_sessions: number }[]>`
        select remaining_sessions from customer_packages where id = ${issued.result.packageId}`);
      expect(afterFailed!.remaining_sessions).toBe(2);

      await dispatch('ticket.pay', {
        ticketId: ticket!.id,
        payments: [],
        packageRedemptions: [{ customerPackageId: issued.result.packageId, units: 1 }],
      }, ownerCtx, { idempotencyKey: `${issued.result.packageId}-good` });
      const [redeem] = await withTenant(tenant, (tx) => tx<{
        remaining: number; covered: number; commission_base: number;
      }[]>`
        select cp.remaining_sessions as remaining,
               (ccl.meta->>'coveredCents')::int as covered,
               (ccl.meta->>'commissionBaseCents')::int as commission_base
        from customer_packages cp join customer_credit_ledger ccl on ccl.subject_id = cp.id
        where cp.id = ${issued.result.packageId} and ccl.entry = 'redeem' and ccl.ticket_id = ${ticket!.id}`);
      expect(redeem).toEqual({ remaining: 1, covered: 10000, commission_base: 4000 });
    } finally {
      await withTenant(tenant, (tx) => tx`update locations set settings = jsonb_set(
        settings, '{checkout}', ${oldCheckout}::jsonb, true) where id = ${NAIL_LOC}`);
    }
  });

  it('创建次卡模板并在 loadPackages 读到', async () => {
    const res = await dispatch<{ templateId: string; created: boolean }>(
      'package.saveTemplate',
      {
        name: '10 次深层精油按摩套餐',
        priceCents: 85000,
        sessions: 10,
        validDays: 365,
      },
      ownerCtx,
    );

    expect(res.result.created).toBe(true);
    expect(res.result.templateId).toBeTruthy();
    templateId = res.result.templateId;
    cleanupPackageTemplateIds.push(templateId);

    const list = await withTenant(tenant, (tx) => loadPackages(tx, ownerCtx));
    const pkg = list.templates.find((t) => t.id === templateId);
    expect(pkg).toBeTruthy();
    expect(pkg?.priceCents).toBe(85000);
    expect(pkg?.sessions).toBe(10);
  });

  it('向客户发售套餐并核销一次', async () => {
    const issueRes = await dispatch<{ packageId: string; totalSessions: number; remainingSessions: number }>(
      'package.issue',
      {
        templateId,
        customerId,
      },
      ownerCtx,
    );

    expect(issueRes.result.packageId).toBeTruthy();
    expect(issueRes.result.remainingSessions).toBe(10);
    issuedPackageId = issueRes.result.packageId;

    // 核销 1 次
    const redeemRes = await dispatch<{ packageId: string; remainingSessions: number; redeemedSessions: number }>(
      'package.redeem',
      {
        packageId: issuedPackageId,
        customerId,
        sessions: 1,
      },
      ownerCtx,
    );

    expect(redeemRes.result.remainingSessions).toBe(9);
    expect(redeemRes.result.redeemedSessions).toBe(1);
  });

  it('前台只报姓名+手机号发售：次卡挂在正确的实名客户名下，不落占位客户', async () => {
    const buyerName = `次卡实名客户-${Math.floor(Math.random() * 1e6)}`;
    const buyerPhone = '+16175550199'; // Fictional NANP number; arbitrary 7 digits can be invalid.

    const issueRes = await dispatch<{ packageId: string; customerId: string }>(
      'package.issue',
      { templateId, customer: { name: buyerName, phoneE164: buyerPhone } },
      ownerCtx,
    );

    // 次卡实际挂载的客户，其姓名必须与前台输入一致（而非写死的占位 UUID）
    const [row] = await withTenant(tenant, (tx) => tx<{ display_name: string; phone_e164: string | null }[]>`
      select c.display_name, c.phone_e164
      from customer_packages cp
      join customers c on c.id = cp.customer_id
      where cp.id = ${issueRes.result.packageId}`);
    expect(row?.display_name).toBe(buyerName);
    expect(row?.phone_e164).toBe(buyerPhone);
    expect(issueRes.result.customerId).not.toBe('00000000-0000-0000-0000-000000000002');

    // 同名同号再发一张：复用同一个客户，不攒重复记录
    const again = await dispatch<{ customerId: string }>(
      'package.issue',
      { templateId, customer: { name: buyerName, phoneE164: buyerPhone } },
      ownerCtx,
    );
    expect(again.result.customerId).toBe(issueRes.result.customerId);
  });
});

describe('优惠券 (Coupons)', () => {
  let couponId = '';

  it('创建优惠券并在 loadCoupons 读到', async () => {
    const res = await dispatch<{ templateId: string; code: string; created: boolean }>(
      'coupon.saveTemplate',
      {
        code: 'SUMMER20',
        name: '夏季特惠 8 折券',
        kind: 'percent',
        percentBp: 2000,
        minSpendCents: 5000,
      },
      ownerCtx,
    );

    expect(res.result.created).toBe(true);
    expect(res.result.code).toBe('SUMMER20');
    couponId = res.result.templateId;
    cleanupCouponIds.push(couponId);

    const list = await withTenant(tenant, (tx) => loadCoupons(tx, ownerCtx));
    const c = list.coupons.find((x) => x.id === couponId);
    expect(c).toBeTruthy();
    expect(c?.code).toBe('SUMMER20');
    expect(c?.percentBp).toBe(2000);
    expect(c?.active).toBe(true);
  });

  it('作废优惠券', async () => {
    const res = await dispatch<{ couponId: string; voided: boolean }>(
      'coupon.void',
      {
        couponId,
        reason: '活动提前结束',
      },
      ownerCtx,
    );

    expect(res.result.voided).toBe(true);
    const list = await withTenant(tenant, (tx) => loadCoupons(tx, ownerCtx));
    const c = list.coupons.find((x) => x.id === couponId);
    expect(c?.active).toBe(false);
  });
});

describe('会员积分 (Loyalty)', () => {
  it('配置积分规则并在 loadLoyalty 中呈现', async () => {
    const res = await dispatch<{ saved: boolean }>(
      'loyalty.saveRules',
      {
        enabled: true,
        earnRateCentsPerPoint: 100, // 消费 $1 得 1 分
        redeemCentsPerPoint: 5,     // 1 分抵 5 分钱
        minRedeemPoints: 200,
      },
      ownerCtx,
    );

    expect(res.result.saved).toBe(true);
    const loyalty = await withTenant(tenant, (tx) => loadLoyalty(tx, ownerCtx));
    expect(loyalty.enabled).toBe(true);
    expect(loyalty.minRedeemPoints).toBe(200);
  });

  it('手动调整客户积分', async () => {
    const res = await dispatch<{ customerId: string; deltaPoints: number; currentPoints: number }>(
      'loyalty.adjustPoints',
      {
        customerId,
        deltaPoints: 500,
        reason: '新会员入会礼包赠送积分',
      },
      ownerCtx,
    );

    expect(res.result.currentPoints).toBe(500);
  });
});

describe('礼品卡列表 (Giftcards Query)', () => {
  it('查询礼品卡列表并返回分页和统计', async () => {
    const res = await withTenant(tenant, (tx) => loadGiftCards(tx, ownerCtx, { limit: 10 }));
    expect(res).toHaveProperty('total');
    expect(res).toHaveProperty('rows');
    expect(res).toHaveProperty('giftCards');
    expect(Array.isArray(res.rows)).toBe(true);
    expect(res.giftCards).toEqual(res.rows);
  });
});
