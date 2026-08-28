/**
 * 顾客档案写命令测试（P0 核心业务）
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { withTenant, closeDb } from '@gf/db';
import { buildContext } from './actor';
import { dispatch } from './bus';
import './handlers/customer';
import { loadCustomerDetail } from './queries/customer';

const NAIL_ORG = '11111111-1111-4111-8111-111111111111';
const NAIL_LOC = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const tenant = { orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: null };

let ownerCtx: Awaited<ReturnType<typeof buildContext>>;
const createdCustomerIds: string[] = [];
const randomPhone = () => `+1617${Math.floor(1000000 + Math.random() * 9000000)}`;

const testPhone1 = randomPhone();
const testPhone2 = randomPhone();

beforeAll(async () => {
  const [owner] = await withTenant(tenant, (tx) => tx<{ id: string; user_id: string }[]>`
    select m.id, m.user_id from memberships m
    join membership_roles mr on mr.membership_id = m.id
    join roles r on r.id = mr.role_id
    where m.location_id = ${NAIL_LOC} and m.status = 'active'
      and r.key in ('owner','manager') and m.user_id is not null limit 1`);
  ownerCtx = await buildContext({ userId: owner!.user_id, membershipId: owner!.id });
});

afterAll(async () => {
  for (const id of createdCustomerIds) {
    try {
      await withTenant(tenant, (tx) => tx`delete from customer_preferences where customer_id = ${id}`);
      await withTenant(tenant, (tx) => tx`delete from customers where id = ${id}`);
    } catch {
      // 忽略因级联或保护引发的删除异常
    }
  }
  await closeDb();
});

describe('customer.saveProfile', () => {
  it('新建顾客档案', async () => {
    const res = await dispatch<{ customerId: string; created: boolean }>(
      'customer.saveProfile',
      {
        name: '王小美',
        phoneE164: testPhone1,
        email: 'xiaomei@example.com',
        vipLevel: 2,
        birthday: '1995-06-18',
        tags: ['新客', '高客单'],
        gender: 'female',
        notes: '喜欢喝温开水',
      },
      ownerCtx,
    );

    expect(res.result.created).toBe(true);
    expect(res.result.customerId).toBeTruthy();
    createdCustomerIds.push(res.result.customerId);

    const detail = await withTenant(tenant, (tx) => loadCustomerDetail(tx, ownerCtx, res.result.customerId));
    expect(detail?.displayName).toBe('王小美');
    expect(detail?.phone).toBe(testPhone1);
    expect(detail?.email).toBe('xiaomei@example.com');
    expect(detail?.vipLevel).toBe(2);
    expect(detail?.tags).toEqual(['新客', '高客单']);
  });

  it('编辑已有顾客档案', async () => {
    const custId = createdCustomerIds[0]!;
    const res = await dispatch<{ customerId: string; created: boolean }>(
      'customer.saveProfile',
      {
        customerId: custId,
        name: '王小美 (VIP)',
        phoneE164: testPhone1,
        vipLevel: 3,
        tags: ['老客', '高客单', '精油过敏'],
      },
      ownerCtx,
    );

    expect(res.result.created).toBe(false);
    expect(res.result.customerId).toBe(custId);

    const detail = await withTenant(tenant, (tx) => loadCustomerDetail(tx, ownerCtx, custId));
    expect(detail?.displayName).toBe('王小美 (VIP)');
    expect(detail?.vipLevel).toBe(3);
    expect(detail?.tags).toContain('精油过敏');
  });
});

describe('customer.savePreferences', () => {
  it('保存客户偏好与健康禁忌', async () => {
    const custId = createdCustomerIds[0]!;
    const res = await dispatch<{ customerId: string; saved: boolean }>(
      'customer.savePreferences',
      {
        customerId: custId,
        allergies: {
          skinAllergies: ['茶树精油'],
          customNotes: '皮肤敏感易泛红',
        },
        freeNotes: '做指甲偏好方形甲',
        profile: {
          pressure: 'gentle',
        },
      },
      ownerCtx,
    );

    expect(res.result.saved).toBe(true);
    const detail = await withTenant(tenant, (tx) => loadCustomerDetail(tx, ownerCtx, custId));
    expect(detail?.preferences.freeNotes).toBe('做指甲偏好方形甲');
    expect(detail?.preferences.profile.pressure).toBe('gentle');
  });
});

describe('customer.setBlocked', () => {
  it('拉黑客户并记录原因', async () => {
    const custId = createdCustomerIds[0]!;
    const res = await dispatch<{ customerId: string; blocked: boolean }>(
      'customer.setBlocked',
      {
        customerId: custId,
        blocked: true,
        reason: '恶意多次爽约并拒绝支付取消费',
      },
      ownerCtx,
    );

    expect(res.result.blocked).toBe(true);
    const detail = await withTenant(tenant, (tx) => loadCustomerDetail(tx, ownerCtx, custId));
    expect(detail?.blockedAt).toBeTruthy();
    expect(detail?.blockedReason).toBe('恶意多次爽约并拒绝支付取消费');
  });

  it('解除拉黑', async () => {
    const custId = createdCustomerIds[0]!;
    const res = await dispatch<{ customerId: string; blocked: boolean }>(
      'customer.setBlocked',
      {
        customerId: custId,
        blocked: false,
      },
      ownerCtx,
    );

    expect(res.result.blocked).toBe(false);
    const detail = await withTenant(tenant, (tx) => loadCustomerDetail(tx, ownerCtx, custId));
    expect(detail?.blockedAt).toBeNull();
  });
});

describe('customer.merge', () => {
  it('合并两个重复的客户档案', async () => {
    // 建立第二个客户
    const res2 = await dispatch<{ customerId: string; created: boolean }>(
      'customer.saveProfile',
      {
        name: '王小妹 (重复)',
        phoneE164: testPhone2,
        tags: ['重复号'],
      },
      ownerCtx,
    );
    const sourceId = res2.result.customerId;
    createdCustomerIds.push(sourceId);
    const targetId = createdCustomerIds[0]!;

    const mergeRes = await dispatch<{
      targetCustomerId: string;
      sourceCustomerId: string;
      mergedCount: number;
    }>(
      'customer.merge',
      {
        targetCustomerId: targetId,
        sourceCustomerId: sourceId,
      },
      ownerCtx,
      { idempotencyKey: `merge-${Date.now()}` },
    );

    expect(mergeRes.result.targetCustomerId).toBe(targetId);
    expect(mergeRes.result.sourceCustomerId).toBe(sourceId);

    const sourceDetail = await withTenant(tenant, (tx) => loadCustomerDetail(tx, ownerCtx, sourceId));
    expect(sourceDetail?.mergedIntoId).toBe(targetId);
  });
});
