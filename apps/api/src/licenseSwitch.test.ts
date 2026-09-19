/**
 * Stripe → 订阅码的切换（计划批 4）
 *
 * ## 这一份只验一件事，但那件事错了最贵
 *
 * **删的是这家店在订阅上的那个 item，不是整条订阅。**
 * 多店经营共用同一条订阅（一个老板一张卡一张账单，sql/0080），
 * 直接 `subscriptions.cancel` 会把老板另外两家店一起停掉 ——
 * 而那两家店没有任何人动过，第二天早上一起冻结。
 *
 * Stripe 那一侧用替身：这里要断言的是**我们对它说了什么**，
 * 而不是它怎么回答（真调用由 `stripe listen` 兜底，见 billing.test.ts 文件头）。
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { closeDb, withTenant, PLATFORM_OPS_USER_ID } from '@gf/db';

const SPA_ORG = '22222222-2222-4222-8222-222222222222';
const SPA_LOC = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const tenant = { orgId: SPA_ORG, locationId: SPA_LOC, membershipId: null };

/** 这一轮 Stripe 收到了哪几条调用。断言的就是它 */
const calls: string[] = [];
/** 这一轮 `subscriptions.retrieve` 该返回什么 */
let subFixture: {
  id: string; status: string; items: { data: Array<{ id: string }> };
} = { id: 'sub_x', status: 'active', items: { data: [{ id: 'si_spa' }] } };

vi.mock('./stripe/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./stripe/client')>();
  return {
    ...actual,
    stripeClient: () => ({
      subscriptions: {
        retrieve: async (id: string) => {
          calls.push(`retrieve:${id}`);
          return subFixture;
        },
        cancel: async (id: string) => {
          calls.push(`cancel:${id}`);
          return { id, status: 'canceled' };
        },
      },
      subscriptionItems: {
        del: async (id: string) => {
          calls.push(`del:${id}`);
          return { id, deleted: true };
        },
      },
    }),
  };
});

const { switchStoreToLicense } = await import('./platform/licenseCommands');

const operator = {
  userId: PLATFORM_OPS_USER_ID,
  operatorId: '55555555-5555-4555-8555-555555555555',
  role: 'super_admin' as const,
  email: 'ops@maildrop.cc',
};

const onStripe = async (): Promise<void> => {
  await withTenant(tenant, (tx) => tx`
    update billing_accounts set
      billing_source = 'stripe', subscription_status = 'active',
      stripe_customer_id = 'cus_x', stripe_subscription_id = 'sub_x',
      stripe_subscription_item_id = 'si_spa',
      current_period_end = now() + interval '20 days',
      license_period_end = null, license_code_id = null
    where location_id = ${SPA_LOC}`);
};

const acct = async (): Promise<{
  billing_source: string; subscription_status: string; item: string | null;
}> => {
  const [row] = await withTenant(tenant, (tx) => tx<{
    billing_source: string; subscription_status: string; item: string | null;
  }[]>`
    select billing_source, subscription_status, stripe_subscription_item_id as item
    from billing_accounts where location_id = ${SPA_LOC}`);
  return row!;
};

const body = {
  kind: 'subscription' as const, plan: 'growth' as const, durationDays: 90,
  paymentNote: 'wechat 2026-09-09 ¥4500',
};

beforeEach(async () => {
  calls.length = 0;
  await onStripe();
});

afterAll(async () => {
  await closeDb();
});

describe('Stripe → 订阅码', () => {
  it('⭐ 订阅上还有别家店的 item 时，只删这家店那个（不取消订阅）', async () => {
    subFixture = {
      id: 'sub_x', status: 'active',
      items: { data: [{ id: 'si_spa' }, { id: 'si_sibling' }] },
    };
    const out = await switchStoreToLicense(operator, SPA_ORG, SPA_LOC, body);
    expect(out.stripeAction).toBe('item_deleted');
    expect(calls).toEqual(['retrieve:sub_x', 'del:si_spa']);
    // ⚠️ 一次 cancel 都不能有 —— 那会连带停掉兄弟门店
    expect(calls.some((c) => c.startsWith('cancel:'))).toBe(false);

    const a = await acct();
    expect(a.billing_source).toBe('license');
    expect(a.subscription_status).toBe('active');
    // item 关联要摘掉，否则下一条 subscription.updated 还会按它落账期
    expect(a.item).toBeNull();
  });

  it('这家店是订阅上最后一个 item 时，取消整条订阅', async () => {
    subFixture = { id: 'sub_x', status: 'active', items: { data: [{ id: 'si_spa' }] } };
    const out = await switchStoreToLicense(operator, SPA_ORG, SPA_LOC, body);
    expect(out.stripeAction).toBe('subscription_canceled');
    expect(calls).toEqual(['retrieve:sub_x', 'cancel:sub_x']);
    expect((await acct()).billing_source).toBe('license');
  });

  it('订阅本来就取消了 → 一次外部调用都不发，直接挂上订阅码', async () => {
    subFixture = { id: 'sub_x', status: 'canceled', items: { data: [{ id: 'si_spa' }] } };
    const out = await switchStoreToLicense(operator, SPA_ORG, SPA_LOC, body);
    expect(out.stripeAction).toBe('already_canceled');
    expect(calls).toEqual(['retrieve:sub_x']);
    expect((await acct()).billing_source).toBe('license');
  });

  /**
   * ⭐ 顺序纪律：**Stripe 先停，成功了才写库**。
   *
   * 反过来的话，写库成功而 Stripe 停不掉 = 客户既在用订阅码又在被按月扣款。
   * 现在这个顺序下最坏的结果是「Stripe 停了但库没写成」——
   * 那家店掉回只读，运营重试一次就好，钱没有多扣。
   */
  it('Stripe 那一步失败 → 库里一个字都不改（订阅码不生效）', async () => {
    subFixture = { id: 'sub_x', status: 'active', items: { data: [{ id: 'si_spa' }] } };
    const boom = new Error('stripe down');
    const spy = vi.spyOn(
      await import('./stripe/client'), 'stripeClient',
    ).mockReturnValue({
      subscriptions: {
        retrieve: async () => { throw boom; },
      },
    } as never);

    await expect(switchStoreToLicense(operator, SPA_ORG, SPA_LOC, body))
      .rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });

    const a = await acct();
    expect(a.billing_source).toBe('stripe');
    expect(a.subscription_status).toBe('active');
    spy.mockRestore();
  });

  it('额度包不走这条路 —— 切换只处理订阅（额度包本来就不改权威）', async () => {
    await expect(switchStoreToLicense(operator, SPA_ORG, SPA_LOC, {
      kind: 'quota_pack', unit: 'credit', amount: 500, paymentNote: 'nope',
    })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { reason: 'switch_requires_subscription_kind' },
    });
    expect(calls).toEqual([]);
  });
});

it('rejects a forbidden special-plan change before touching Stripe', async () => {
  await withTenant(tenant, tx => tx`update billing_accounts set plan='voice_booking' where location_id=${SPA_LOC}`);
  try {
    await expect(switchStoreToLicense(operator, SPA_ORG, SPA_LOC, { ...body, plan: 'essential' }))
      .rejects.toMatchObject({ details: { reason: 'voice_booking_can_only_switch_to_growth' } });
    expect(calls).toEqual([]);
    expect((await acct()).billing_source).toBe('stripe');
  } finally {
    await withTenant(tenant, tx => tx`update billing_accounts set plan='growth' where location_id=${SPA_LOC}`);
  }
});
