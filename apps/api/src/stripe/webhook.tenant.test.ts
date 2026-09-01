/**
 * Batch 4: invoice webhook tenant resolution + signed webhook invariants.
 *
 * Invoice objects often have empty metadata. Tenant mapping must then use a
 * Stripe subscription/customer id we already stored, never a browser input,
 * and never an ambiguous match.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, findBillingTenantByStripeRefs, withTenant } from '@gf/db';
import { signStripePayload } from './verify';
import { resolveWebhookTenant } from './tenant';
import { buildServer } from '../server';
import type { Stripe } from './client';

const SPA_ORG = '22222222-2222-4222-8222-222222222222';
const SPA_LOC = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const NAIL_ORG = '11111111-1111-4111-8111-111111111111';
const NAIL_LOC = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';

const SPA = { orgId: SPA_ORG, locationId: SPA_LOC };
const NAIL = { orgId: NAIL_ORG, locationId: NAIL_LOC };

const SECRET = 'whsec_test_batch4_invoice_tenant';
const SPA_SUB = 'sub_batch4_spa';
const SPA_CUS = 'cus_batch4_spa';
const NAIL_SUB = 'sub_batch4_nail';
const NAIL_CUS = 'cus_batch4_nail';
const UNKNOWN_SUB = 'sub_batch4_unknown';
const UNKNOWN_CUS = 'cus_batch4_unknown';

let app: ReturnType<typeof buildServer>;
let previousSecret: string | undefined;

function eventId(suffix: string): string {
  return `evt_batch4_${suffix}`;
}

function invoiceEvent(over: {
  id: string;
  metadata?: Record<string, string>;
  subscription?: string | Record<string, unknown> | null;
  customer?: string | Record<string, unknown> | null;
  parent?: Record<string, unknown>;
}): Stripe.Event {
  return {
    id: over.id,
    object: 'event',
    type: 'invoice.payment_failed',
    data: {
      object: {
        id: `in_${over.id}`,
        object: 'invoice',
        metadata: over.metadata ?? {},
        subscription: over.subscription ?? null,
        customer: over.customer ?? null,
        parent: over.parent,
        amount_due: 9900,
        attempt_count: 1,
        next_payment_attempt: null,
      },
    },
  } as unknown as Stripe.Event;
}

function subscriptionEvent(over: {
  id: string;
  locationId: string;
  orgId: string;
  status?: string;
  customer?: string;
  subscriptionId?: string;
  defaultPaymentMethod?: unknown;
}): Stripe.Event {
  return {
    id: over.id,
    object: 'event',
    type: 'customer.subscription.updated',
    data: {
      object: {
        id: over.subscriptionId ?? 'sub_batch4_sync',
        object: 'subscription',
        customer: over.customer ?? 'cus_batch4_sync',
        status: over.status ?? 'active',
        trial_end: null,
        default_payment_method: over.defaultPaymentMethod ?? null,
        items: { data: [{ current_period_end: 1_789_000_000 }] },
        metadata: {
          gf_location_id: over.locationId,
          gf_org_id: over.orgId,
        },
      },
    },
  } as unknown as Stripe.Event;
}

async function setStripeRefs(
  tenant: { orgId: string; locationId: string },
  refs: { customer: string | null; subscription: string | null },
): Promise<void> {
  await withTenant({ ...tenant, membershipId: null }, (tx) => tx`
    insert into billing_accounts (org_id, location_id, stripe_customer_id, stripe_subscription_id)
    values (${tenant.orgId}, ${tenant.locationId}, ${refs.customer}, ${refs.subscription})
    on conflict (location_id) do update
    set stripe_customer_id = excluded.stripe_customer_id,
        stripe_subscription_id = excluded.stripe_subscription_id`);
}

async function snapshot(tenant: { orgId: string; locationId: string }) {
  const [row] = await withTenant({ ...tenant, membershipId: null }, (tx) => tx<{
    plan: string;
    subscription_status: string;
    stripe_customer_id: string | null;
    stripe_subscription_id: string | null;
    credit_balance: number;
    voice_minute_balance: number;
    default_payment_method_id: string | null;
    payment_method_label: string | null;
  }[]>`
    select plan, subscription_status, stripe_customer_id, stripe_subscription_id,
           credit_balance, voice_minute_balance,
           default_payment_method_id, payment_method_label
    from billing_accounts
    where location_id = ${tenant.locationId}`);
  return row!;
}

async function postWebhook(event: Stripe.Event, signature?: string) {
  const raw = JSON.stringify(event);
  const now = Math.floor(Date.now() / 1000);
  return app.inject({
    method: 'POST',
    url: '/v1/stripe/webhook',
    headers: {
      'content-type': 'application/json',
      'stripe-signature': signature ?? signStripePayload(raw, SECRET, now),
    },
    payload: raw,
  });
}

beforeAll(async () => {
  previousSecret = process.env['STRIPE_WEBHOOK_SECRET'];
  process.env['STRIPE_WEBHOOK_SECRET'] = SECRET;
  app = buildServer();
  await app.ready();
  await setStripeRefs(SPA, { customer: SPA_CUS, subscription: SPA_SUB });
  await setStripeRefs(NAIL, { customer: NAIL_CUS, subscription: NAIL_SUB });
});

afterAll(async () => {
  await setStripeRefs(SPA, { customer: null, subscription: null });
  await setStripeRefs(NAIL, { customer: null, subscription: null });
  if (previousSecret === undefined) delete process.env['STRIPE_WEBHOOK_SECRET'];
  else process.env['STRIPE_WEBHOOK_SECRET'] = previousSecret;
  await app.close();
  await closeDb();
});

describe('invoice tenant resolution', () => {
  it('invoice with direct gf_location_id metadata still resolves', async () => {
    const tenant = await resolveWebhookTenant(invoiceEvent({
      id: eventId('meta'),
      metadata: { gf_location_id: SPA_LOC, gf_org_id: SPA_ORG },
      subscription: NAIL_SUB,
      customer: NAIL_CUS,
    }));
    expect(tenant).toEqual(SPA);
  });

  it('invoice without metadata maps a known subscription to the right tenant', async () => {
    const tenant = await resolveWebhookTenant(invoiceEvent({
      id: eventId('sub'),
      subscription: SPA_SUB,
      customer: SPA_CUS,
    }));
    expect(tenant).toEqual(SPA);
  });

  it('invoice without metadata maps a known customer when subscription is absent', async () => {
    const tenant = await resolveWebhookTenant(invoiceEvent({
      id: eventId('cus'),
      customer: NAIL_CUS,
    }));
    expect(tenant).toEqual(NAIL);
  });

  it('nested subscription_details metadata resolves without a local id match', async () => {
    const tenant = await resolveWebhookTenant(invoiceEvent({
      id: eventId('nested'),
      subscription: UNKNOWN_SUB,
      customer: UNKNOWN_CUS,
      parent: {
        type: 'subscription_details',
        subscription_details: {
          subscription: UNKNOWN_SUB,
          metadata: { gf_location_id: NAIL_LOC, gf_org_id: NAIL_ORG },
        },
      },
    }));
    expect(tenant).toEqual(NAIL);
  });

  it('unknown Stripe invoice does not resolve to a random tenant', async () => {
    expect(await resolveWebhookTenant(invoiceEvent({
      id: eventId('unknown'),
      subscription: UNKNOWN_SUB,
      customer: UNKNOWN_CUS,
    }))).toBeNull();
    expect(await findBillingTenantByStripeRefs({
      subscriptionId: UNKNOWN_SUB,
      customerId: UNKNOWN_CUS,
    })).toBeNull();
  });

  /**
   * ⭐ AUD-02：跨 org 共用一个 Stripe id 现在**根本写不进去**。
   *
   * 这条用例原来是「写进去两行，然后断言解析器不猜」——
   * 那是第二道防线。第一道现在也有了（sql/0080 的触发器），
   * 于是断言的对象从「解析器的行为」变成了「这种状态不可达」。
   *
   * 为什么这件事要紧：能写进去的话，把受害门店的 `sub_…` 抄进自己这一行
   * 就能让**对方的发票事件从此认不出租户**，续费/欠费状态静默停更，
   * 两边都不会收到任何报错。
   */
  it('cross-org Stripe id sharing is rejected by the database', async () => {
    await setStripeRefs(SPA, { customer: 'cus_shared_batch4', subscription: 'sub_shared_batch4' });
    try {
      await expect(
        setStripeRefs(NAIL, { customer: 'cus_shared_batch4', subscription: 'sub_shared_batch4' }),
      ).rejects.toThrow(/已属于另一个 org|already/i);

      // 第二道仍然在：真正未知的 id 一律返回 null，绝不猜
      expect(await findBillingTenantByStripeRefs({
        subscriptionId: 'sub_never_seen_batch4',
        customerId: 'cus_never_seen_batch4',
      })).toBeNull();
    } finally {
      await setStripeRefs(SPA, { customer: SPA_CUS, subscription: SPA_SUB });
      await setStripeRefs(NAIL, { customer: NAIL_CUS, subscription: NAIL_SUB });
    }
  });

  /**
   * 同一个 org 的多家门店**故意**共用一个 Stripe 客户和一条订阅
   * （一个老板一张卡一张账单，见 `handlers/setup.ts`）。
   *
   * 0072 版本的解析器在「命中多于一行」时一律返回 null —— 也就是说
   * **多店老板的发票事件一直认不出租户**，从来没人从这个角度看过。
   * 现在同 org 的多行不算歧义：取该 org 建得最早的那家店作为计费锚点。
   */
  it('same-org multi-location sharing resolves to one anchor location', async () => {
    const [sibling] = await withTenant({ ...SPA, membershipId: null },
      (tx) => tx<{ id: string }[]>`
        select id from locations where org_id = ${SPA_ORG} and id <> ${SPA_LOC} limit 1`);
    if (!sibling) return;   // 种子里这个 org 只有一家店时无从验证

    await setStripeRefs({ orgId: SPA_ORG, locationId: sibling.id },
      { customer: SPA_CUS, subscription: SPA_SUB });
    try {
      const t = await findBillingTenantByStripeRefs({
        subscriptionId: SPA_SUB, customerId: SPA_CUS,
      });
      expect(t, '多店共用不该被当成歧义').not.toBeNull();
      expect(t!.orgId).toBe(SPA_ORG);
    } finally {
      await setStripeRefs({ orgId: SPA_ORG, locationId: sibling.id },
        { customer: null, subscription: null });
    }
  });
});

/**
 * ⚠️ `handled` 从 `invoice_failure_logged` 变成 `invoice_failure_notified`（0085）。
 *
 * 扣款失败原来只写一行日志 —— 于是老板得到的唯一信号是第二天早上前台
 * 开不了单。现在这条路会把发票落库并给 owner 入队一封信；
 * 找不到 owner 邮箱时才退回 `invoice_failure_logged`。
 */
describe('signed invoice webhook HTTP', () => {
  it('invoice with direct metadata is handled for that tenant', async () => {
    const res = await postWebhook(invoiceEvent({
      id: eventId('http_meta'),
      metadata: { gf_location_id: SPA_LOC, gf_org_id: SPA_ORG },
    }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, handled: 'invoice_failure_notified' });
    const [row] = await withTenant({ ...SPA, membershipId: null }, (tx) => tx<{ location_id: string }[]>`
      select location_id from stripe_events where id = ${eventId('http_meta')}`);
    expect(row?.location_id).toBe(SPA_LOC);
  });

  it('invoice without metadata uses stored subscription mapping', async () => {
    const res = await postWebhook(invoiceEvent({
      id: eventId('http_sub'),
      subscription: SPA_SUB,
      customer: SPA_CUS,
    }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, handled: 'invoice_failure_notified' });
  });

  it('unknown invoice is ignored, not assigned', async () => {
    const before = await snapshot(SPA);
    const res = await postWebhook(invoiceEvent({
      id: eventId('http_unknown'),
      subscription: UNKNOWN_SUB,
      customer: UNKNOWN_CUS,
    }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, ignored: 'no_tenant_metadata' });
    const rows = await withTenant({ ...SPA, membershipId: null }, (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from stripe_events where id = ${eventId('http_unknown')}`);
    expect(rows[0]!.n).toBe(0);
    expect(await snapshot(SPA)).toEqual(before);
  });

  it('tenant A invoice never mutates tenant B', async () => {
    const beforeB = await snapshot(NAIL);
    const invoiceRes = await postWebhook(invoiceEvent({
      id: eventId('iso_inv'),
      subscription: SPA_SUB,
      customer: SPA_CUS,
    }));
    expect(invoiceRes.json()).toMatchObject({ ok: true, handled: 'invoice_failure_notified' });

    const syncRes = await postWebhook(subscriptionEvent({
      id: eventId('iso_sub'),
      locationId: SPA_LOC,
      orgId: SPA_ORG,
      status: 'active',
      customer: SPA_CUS,
      subscriptionId: SPA_SUB,
    }));
    expect(syncRes.json()).toMatchObject({ ok: true, handled: 'subscription_synced' });

    const afterA = await snapshot(SPA);
    expect(afterA.subscription_status).toBe('active');
    expect(await snapshot(NAIL)).toEqual(beforeB);

    const events = await withTenant({ ...SPA, membershipId: null }, (tx) => tx<{ id: string; location_id: string }[]>`
      select id, location_id from stripe_events
      where id = ${eventId('iso_inv')} or id = ${eventId('iso_sub')}`);
    expect(events).toHaveLength(2);
    expect(events.every((row) => row.location_id === SPA_LOC)).toBe(true);
  });

  it('missing or forged signature is rejected and does not claim the event', async () => {
    const beforeA = await snapshot(SPA);
    const ev = invoiceEvent({
      id: eventId('bad_sig'),
      metadata: { gf_location_id: SPA_LOC, gf_org_id: SPA_ORG },
    });
    const missing = await postWebhook(ev, '');
    expect(missing.statusCode).toBe(401);
    const forged = await postWebhook(ev, `t=${Math.floor(Date.now() / 1000)},v1=${'ab'.repeat(32)}`);
    expect(forged.statusCode).toBe(401);
    const rows = await withTenant({ ...SPA, membershipId: null }, (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from stripe_events where id = ${eventId('bad_sig')}`);
    expect(rows[0]!.n).toBe(0);
    expect(await snapshot(SPA)).toEqual(beforeA);
  });

  it('duplicate Stripe event stays idempotent', async () => {
    const ev = invoiceEvent({
      id: eventId('dup'),
      metadata: { gf_location_id: SPA_LOC, gf_org_id: SPA_ORG },
    });
    const first = await postWebhook(ev);
    expect(first.json()).toMatchObject({ ok: true, handled: 'invoice_failure_notified' });
    const second = await postWebhook(ev);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ ok: true, duplicate: true });
  });

  it('subscription sync still uses billing.syncSubscription from the signed webhook', async () => {
    const beforeB = await snapshot(NAIL);
    const res = await postWebhook(subscriptionEvent({
      id: eventId('sync'),
      locationId: SPA_LOC,
      orgId: SPA_ORG,
      status: 'past_due',
      customer: SPA_CUS,
      subscriptionId: SPA_SUB,
    }));
    expect(res.json()).toMatchObject({ ok: true, handled: 'subscription_synced' });
    expect((await snapshot(SPA)).subscription_status).toBe('past_due');
    expect(await snapshot(NAIL)).toEqual(beforeB);
  });

  it('subscription sync projects Stripe default_payment_method via billing.savePaymentMethod', async () => {
    const beforeB = await snapshot(NAIL);
    const res = await postWebhook(subscriptionEvent({
      id: eventId('pm_sync'),
      locationId: SPA_LOC,
      orgId: SPA_ORG,
      status: 'active',
      customer: SPA_CUS,
      subscriptionId: SPA_SUB,
      defaultPaymentMethod: {
        id: 'pm_qa_webhook_4242',
        object: 'payment_method',
        type: 'card',
        card: { brand: 'visa', last4: '4242' },
      },
    }));
    expect(res.json()).toMatchObject({ ok: true, handled: 'subscription_synced' });
    const after = await snapshot(SPA);
    expect(after.subscription_status).toBe('active');
    expect(after.default_payment_method_id).toBe('pm_qa_webhook_4242');
    expect(after.payment_method_label).toBe('Visa ···· 4242');
    expect(await snapshot(NAIL)).toEqual(beforeB);
  });

  it('subscription sync does not invent a payment method when Stripe has none', async () => {
    await withTenant({ ...SPA, membershipId: null }, (tx) => tx`
      update billing_accounts
      set default_payment_method_id = null, payment_method_label = null
      where location_id = ${SPA_LOC}`);
    const res = await postWebhook(subscriptionEvent({
      id: eventId('pm_absent'),
      locationId: SPA_LOC,
      orgId: SPA_ORG,
      status: 'active',
      customer: SPA_CUS,
      subscriptionId: SPA_SUB,
    }));
    expect(res.json()).toMatchObject({ ok: true, handled: 'subscription_synced' });
    const after = await snapshot(SPA);
    expect(after.default_payment_method_id).toBeNull();
    expect(after.payment_method_label).toBeNull();
  });
});

/**
 * ⭐ `customer.subscription.*` 的租户兜底（0085）。
 *
 * 修复之前这类事件**只认 metadata**。而那份 metadata 是开户之后由
 * `backfillStripeMetadata` 回写上去的，回写失败时只记一条日志 ——
 * 于是这家店此后的每一条续费、欠费、退订事件都被静默丢弃并回 200，
 * 一个月后才会有人发现「这家店的订阅状态从来没变过」。
 */
describe('subscription event tenant fallback', () => {
  function bareSubscriptionEvent(over: {
    id: string; subscriptionId?: string | null; customer?: string | null;
  }): Stripe.Event {
    return {
      id: over.id,
      object: 'event',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: over.subscriptionId ?? 'sub_batch4_bare',
          object: 'subscription',
          customer: over.customer ?? null,
          status: 'active',
          trial_end: null,
          // ⚠️ metadata 是空的 —— 这正是回写失败之后的样子
          metadata: {},
          items: { data: [{ id: 'si_bare', current_period_end: 1_789_000_000 }] },
        },
      },
    } as unknown as Stripe.Event;
  }

  it('⭐ metadata 丢了也能按 subscription id 认回门店', async () => {
    expect(await resolveWebhookTenant(bareSubscriptionEvent({
      id: eventId('sub_fallback'), subscriptionId: SPA_SUB, customer: SPA_CUS,
    }))).toEqual(SPA);
  });

  it('只有 customer id 时同样认得回来', async () => {
    expect(await resolveWebhookTenant(bareSubscriptionEvent({
      id: eventId('cus_fallback'), subscriptionId: 'sub_never_stored', customer: NAIL_CUS,
    }))).toEqual(NAIL);
  });

  it('两个 id 都不认识时仍然不猜', async () => {
    expect(await resolveWebhookTenant(bareSubscriptionEvent({
      id: eventId('none_fallback'),
      subscriptionId: UNKNOWN_SUB, customer: UNKNOWN_CUS,
    }))).toBeNull();
  });

  it('退款事件按 customer 认门店（charge 上没有我们的 metadata）', async () => {
    const refund = {
      id: eventId('refund'),
      object: 'event',
      type: 'charge.refunded',
      data: {
        object: {
          id: 'ch_batch4_refund', object: 'charge',
          customer: SPA_CUS, payment_intent: 'pi_batch4_refund', metadata: {},
        },
      },
    } as unknown as Stripe.Event;
    expect(await resolveWebhookTenant(refund)).toEqual(SPA);
  });
});
