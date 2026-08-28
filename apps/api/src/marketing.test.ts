/**
 * 营销体系测试（P1 次卡套餐 / 优惠券 / 积分 / 礼品卡列表）
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { withTenant, closeDb } from '@gf/db';
import { buildContext } from './actor';
import { dispatch } from './bus';
import './handlers/marketing';
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
  for (const id of cleanupPackageTemplateIds) {
    await withTenant(tenant, (tx) => tx`delete from customer_packages where template_id = ${id}`);
    await withTenant(tenant, (tx) => tx`delete from package_templates where id = ${id}`);
  }
  for (const id of cleanupCouponIds) {
    await withTenant(tenant, (tx) => tx`delete from coupon_templates where id = ${id}`);
  }
  await closeDb();
});

describe('次卡套餐 (Packages)', () => {
  let templateId = '';
  let issuedPackageId = '';

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
    expect(Array.isArray(res.rows)).toBe(true);
  });
});
