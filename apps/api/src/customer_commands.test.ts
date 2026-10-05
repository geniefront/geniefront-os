/**
 * 顾客档案写命令测试（P0 核心业务）
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { withTenant, closeDb } from '@gf/db';
import { buildContext } from './actor';
import { dispatch } from './bus';
import './handlers/customer';
import { loadCustomerDetail } from './queries/customer';
import { canonicalCustomer, canonicalCustomerMap, customerAssetIds } from './customerIdentity';

const NAIL_ORG = '11111111-1111-4111-8111-111111111111';
const NAIL_LOC = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const tenant = { orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: null };

let ownerCtx: Awaited<ReturnType<typeof buildContext>>;
const createdCustomerIds: string[] = [];
const randomPhone = () => `+1617555${Math.floor(1000 + Math.random() * 9000)}`;

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
        email: 'xiaomei@maildrop.cc',
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
    expect(detail?.email).toBe('xiaomei@maildrop.cc');
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

describe('customer profile PATCH', () => {
  it('preserves omitted fields and clears only explicitly supplied nulls', async () => {
    const created = await dispatch<{ customerId: string }>('customer.saveProfile', {
      name: 'Patch guest', firstName: 'Patch', lastName: 'Guest', notes: 'Preserve me', source: 'referral',
      phoneE164: '+16175550127', email: 'patch@example.com', vipLevel: 2, tags: ['regular'], birthday: '1990-01-02',
    }, ownerCtx);
    const customerId = created.result.customerId;
    createdCustomerIds.push(customerId);
    await dispatch('customer.saveProfile', { customerId, name: 'Renamed' }, ownerCtx);
    const detail = await withTenant(tenant, tx => loadCustomerDetail(tx, ownerCtx, customerId));
    expect(detail).toMatchObject({ displayName: 'Renamed', firstName: 'Patch', lastName: 'Guest', notes: 'Preserve me',
      source: 'referral', phone: '+16175550127', email: 'patch@example.com', vipLevel: 2, tags: ['regular'], birthday: '1990-01-02' });
    await dispatch('customer.saveProfile', { customerId, name: 'Renamed', notes: null, phoneE164: null, birthday: null }, ownerCtx);
    const cleared = await withTenant(tenant, tx => loadCustomerDetail(tx, ownerCtx, customerId));
    expect(cleared).toMatchObject({ notes: null, phone: null, birthday: null, firstName: 'Patch', source: 'referral' });
    await expect(dispatch('customer.saveProfile', { customerId, name: 'Stale overwrite', expectedVersion: detail!.version }, ownerCtx)).rejects.toMatchObject({ details: { reason: 'customer_changed_reload' } });
    expect((await withTenant(tenant, tx => loadCustomerDetail(tx, ownerCtx, customerId)))?.displayName).toBe('Renamed');
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
  it('keeps explicit alias chains tenant scoped and serializes identity readers with a merge', async () => {
    const ids: string[] = [];
    for (const name of ['Alias original', 'Alias middle', 'Alias final']) {
      const saved = await dispatch<{ customerId: string }>('customer.saveProfile', { name, phoneE164: '+16175550194' }, ownerCtx);
      ids.push(saved.result.customerId); createdCustomerIds.push(saved.result.customerId);
    }
    const [source, middle, target] = ids as [string, string, string];
    await dispatch('customer.merge', { sourceCustomerId: source, targetCustomerId: middle }, ownerCtx, { idempotencyKey: crypto.randomUUID() });
    let release!: () => void;
    let ready!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const acquired = new Promise<void>(resolve => { ready = resolve; });
    const reader = withTenant(tenant, async tx => {
      expect(await canonicalCustomer(tx, source)).toBe(middle);
      ready(); await gate;
      expect(await canonicalCustomer(tx, source)).toBe(middle);
    });
    await acquired;
    try {
      const [lock] = await withTenant(tenant, tx => tx<{ available: boolean }[]>`select pg_try_advisory_xact_lock(hashtext(app_org_id()::text),hashtext('customer.merge')) as available`);
      expect(lock!.available).toBe(false);
    } finally { release(); await reader; }
    await dispatch('customer.merge', { sourceCustomerId: middle, targetCustomerId: target }, ownerCtx, { idempotencyKey: crypto.randomUUID() });
    await withTenant(tenant, async tx => {
      expect(await canonicalCustomer(tx, source)).toBe(target);
      expect([...(await canonicalCustomerMap(tx, ids)).values()]).toEqual([target, target, target]);
      const family = await tx<{ id: string }[]>`select id from customers where id in ${customerAssetIds(tx, target)}`;
      expect(family.map(r => r.id).sort()).toEqual([...ids].sort());
      const [root] = await tx<{ id: string }[]>`select gf_customer_root(${source}::uuid) as id`;
      expect(root!.id).toBe(target);
    });
    const otherTenant = { orgId: '22222222-2222-4222-8222-222222222222', locationId: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', membershipId: null };
    const [foreign] = await withTenant(otherTenant, tx => tx<{ id: string }[]>`select id from customers limit 1`);
    expect(foreign).toBeDefined();
    await expect(dispatch('customer.merge', { sourceCustomerId: target, targetCustomerId: foreign!.id }, ownerCtx, { idempotencyKey: crypto.randomUUID() })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await withTenant(tenant, async tx => {
      const [security] = await tx<{ foreign_root: string | null; anon: boolean; authenticated: boolean; invoker: boolean }[]>`select gf_customer_root(${foreign!.id}::uuid) as foreign_root,
        has_function_privilege('anon','gf_customer_root(uuid)','execute') as anon,
        has_function_privilege('authenticated','gf_customer_root(uuid)','execute') as authenticated,
        not prosecdef as invoker from pg_proc where oid='gf_customer_root(uuid)'::regprocedure`;
      expect(security).toEqual({ foreign_root: null, anon: false, authenticated: false, invoker: true });
      expect(await canonicalCustomer(tx, source)).toBe(target);
    });
    await expect(withTenant(tenant, tx => canonicalCustomer(tx, foreign!.id))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await withTenant(tenant, tx => loadCustomerDetail(tx, ownerCtx, foreign!.id))).toBeNull();
  });
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
