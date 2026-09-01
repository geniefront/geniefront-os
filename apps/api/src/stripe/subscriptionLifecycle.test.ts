/**
 * 订阅生命周期（0085 那一批修复的验收）。
 *
 * 盯的是审查里最贵的那几条 —— 每一条都**不会在单店场景下暴露**，
 * 所以必须有一份专门跑多店与状态迁移的套件：
 *
 *   1. **兄弟门店的订阅状态会不会跟着变。** 多店共用一条订阅，而一条
 *      `customer.subscription.*` 只解析得出一家店。不广播的话，老板退订
 *      之后第二家店永远是 active —— 继续开单、继续烧 AI 额度
 *   2. **多 item 订阅会不会串档。** `items.data[0]` 的顺序 Stripe 不保证，
 *      取错一个就是主店被静默升/降档
 *   3. **期末取消看不看得见。** Stripe 这时 status 仍然是 active
 *   4. **从没接过计费的店有没有白拿一整份套餐额度**
 *   5. **已经有订阅的店还能不能再开一条 Checkout**（那是双重扣款）
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { withTenant, closeDb } from '@gf/db';
import { PLAN_QUOTAS } from '@gf/payroll';
import { buildContext } from '../actor';
import { dispatch } from '../bus';
import { dispatchSystem } from '../test/systemDispatch';
import { loadBilling } from '../queries/billing';
import { includedTotalOf, type AccountRow } from '../handlers/billing';
import '../handlers/billing';
import '../handlers/setup';
/**
 * 冻结闸门要一条**非 billing** 的命令才验得出来（`billing.` 前缀是豁免的，
 * 否则老板换了卡也救不回来）。选 `staff.setLocale`：它只写一列语言，
 * 不留任何跨文件的脏数据。
 */
import '../handlers/staff';

const SPA_ORG = '22222222-2222-4222-8222-222222222222';
const SPA_LOC = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const tenant = { orgId: SPA_ORG, locationId: SPA_LOC, membershipId: null };

const SUB = 'sub_lifecycle_shared';
const CUS = 'cus_lifecycle_shared';
const ITEM_MAIN = 'si_lifecycle_main';
const ITEM_SECOND = 'si_lifecycle_second';

let ctx: Awaited<ReturnType<typeof buildContext>>;
/** 第二家店。整份套件共用一家，拆的时候一起删 */
let secondLoc = '';
/**
 * 第二家店的操作上下文。
 *
 * ⚠️ 不能拿主店的 ctx 改一个 locationId 就用 —— `membershipId` 要和门店
 * 对得上，否则命令在归属校验那一步就报 NOT_FOUND，测出来的是「上下文
 * 拼错了」而不是「冻结生效了」。`location.create` 已经把调用方设成了
 * 新店的 owner，这里按那条 membership 建上下文。
 */
let secondCtx: Awaited<ReturnType<typeof buildContext>>;

const run = async <T>(name: string, input: unknown): Promise<T> =>
  (await dispatch<T>(name, input, ctx, { idempotencyKey: crypto.randomUUID() })).result;

/** 生产里这条命令的调用方是 Stripe webhook，不是浏览器（AUD-01） */
const sync = async (input: unknown, locationId = SPA_LOC): Promise<unknown> =>
  (await dispatchSystem(
    'billing.syncSubscription', input, { ...ctx, locationId, membershipId: null },
  )).result;

async function accountOf(locationId: string): Promise<AccountRow> {
  const [row] = await withTenant(
    { orgId: SPA_ORG, locationId, membershipId: null },
    (tx) => tx<AccountRow[]>`select * from billing_accounts where location_id = ${locationId}`);
  return row!;
}

beforeAll(async () => {
  const [m] = await withTenant(tenant, (tx) => tx<{ id: string; user_id: string }[]>`
    select m.id, m.user_id from memberships m
    join membership_roles mr on mr.membership_id = m.id
    join roles r on r.id = mr.role_id
    where m.location_id = ${SPA_LOC} and m.status = 'active' and r.key = 'owner'
    limit 1`);
  ctx = await buildContext({ userId: m!.user_id, membershipId: m!.id });

  const created = await run<{ locationId: string }>('location.create', {
    name: 'Lifecycle Second Store', timezone: 'America/New_York', businessType: 'foot_spa',
  });
  secondLoc = created.locationId;

  const [second] = await withTenant(
    { orgId: SPA_ORG, locationId: secondLoc, membershipId: null },
    (tx) => tx<{ id: string; user_id: string }[]>`
      select id, user_id from memberships
      where location_id = ${secondLoc} and status = 'active' and user_id is not null
      limit 1`);
  secondCtx = await buildContext({ userId: second!.user_id, membershipId: second!.id });
});

afterAll(async () => {
  // 拆的顺序反着建（同 multistore.test.ts）：少拆一层，下一次跑会撞外键，
  // 而报错指向的是一个和本文件无关的地方
  await withTenant({ orgId: SPA_ORG, locationId: secondLoc, membershipId: null }, async (tx) => {
    await tx`delete from staff_profiles where location_id = ${secondLoc}`;
    await tx`delete from membership_roles mr using memberships m
             where mr.membership_id = m.id and m.location_id = ${secondLoc}`;
    await tx`delete from memberships where location_id = ${secondLoc}`;
    await tx`delete from role_permissions rp using roles r
             where rp.role_id = r.id and r.location_id = ${secondLoc}`;
    await tx`delete from roles where location_id = ${secondLoc}`;
    await tx`delete from location_subscriptions where location_id = ${secondLoc}`;
    await tx`delete from billing_accounts where location_id = ${secondLoc}`;
  });
  await withTenant(tenant, (tx) => tx`delete from locations where id = ${secondLoc}`);
  await withTenant(tenant, (tx) => tx`
    update billing_accounts set
      stripe_customer_id = null, stripe_subscription_id = null,
      stripe_subscription_item_id = null, subscription_status = 'trialing',
      plan = 'essential', current_period_end = null, trial_ends_at = null,
      cancel_at_period_end = false, cancel_at = null,
      included_credits_used = 0, included_minutes_used = 0
    where location_id = ${SPA_LOC}`);
  await closeDb();
});

/** 每个用例从「两家店挂在同一条订阅上、都是 active」开始 */
beforeEach(async () => {
  for (const [loc, item, plan] of [
    [SPA_LOC, ITEM_MAIN, 'essential'],
    [secondLoc, ITEM_SECOND, 'growth'],
  ] as const) {
    await withTenant({ orgId: SPA_ORG, locationId: loc, membershipId: null }, (tx) => tx`
      insert into billing_accounts
        (org_id, location_id, stripe_customer_id, stripe_subscription_id,
         stripe_subscription_item_id, plan, subscription_status,
         current_period_end, cancel_at_period_end, cancel_at,
         included_credits_used, included_minutes_used, trial_ends_at)
      values (${SPA_ORG}, ${loc}, ${CUS}, ${SUB}, ${item}, ${plan}, 'active',
              '2026-09-01T00:00:00Z'::timestamptz, false, null, 0, 0, null)
      on conflict (location_id) do update set
        stripe_customer_id = excluded.stripe_customer_id,
        stripe_subscription_id = excluded.stripe_subscription_id,
        stripe_subscription_item_id = excluded.stripe_subscription_item_id,
        plan = excluded.plan,
        subscription_status = excluded.subscription_status,
        current_period_end = excluded.current_period_end,
        cancel_at_period_end = false, cancel_at = null,
        included_credits_used = 0, included_minutes_used = 0,
        trial_ends_at = null`);
  }
});

describe('多店共用一条订阅', () => {
  /**
   * ⭐ 这一条是整份套件里最贵的。
   *
   * 修复之前：`billing.syncSubscription` 只更新 `ctx.locationId` 那一行，
   * 而 webhook 解析出来的永远是「建得最早的那家」。于是老板退订之后，
   * 第二家店的 `subscription_status` 停在 active —— 写入闸门（bus.ts）
   * 和 AI 准入（aiAdmission.ts）都是按 location 读自己那一行的。
   */
  it('⭐ 退订广播到同一条订阅上的每一家店', async () => {
    await sync({
      stripeCustomerId: CUS,
      stripeSubscriptionId: SUB,
      subscriptionStatus: 'canceled',
      items: [
        { locationId: SPA_LOC, subscriptionItemId: ITEM_MAIN, plan: 'essential' },
        { locationId: secondLoc, subscriptionItemId: ITEM_SECOND, plan: 'growth' },
      ],
    });

    expect((await accountOf(SPA_LOC)).subscription_status).toBe('canceled');
    expect((await accountOf(secondLoc)).subscription_status).toBe('canceled');
  });

  it('⭐ 欠费同样广播 —— 第二家店不能继续开单', async () => {
    await sync({
      stripeCustomerId: CUS, stripeSubscriptionId: SUB, subscriptionStatus: 'past_due',
    });
    expect((await accountOf(secondLoc)).subscription_status).toBe('past_due');

    // 冻结是按各自那一行判的，所以广播到位之后第二家店必须真的写不进去
    await expect(dispatch('staff.setLocale', { locale: 'en' }, secondCtx,
      { idempotencyKey: crypto.randomUUID() }))
      .rejects.toMatchObject({ code: 'SUBSCRIPTION_PAST_DUE' });
  });

  /**
   * ⭐ `items.data[0]` 的顺序 Stripe 不保证。
   *
   * 修复之前，主店的套餐会被列表里第一个 item 决定 —— 而第二家店加进来
   * 之后那个「第一个」可能就是它。表现是主店被静默升/降档，账单上看不出来。
   */
  it('⭐ 每家店按自己的 item 落套餐，顺序颠倒也不串档', async () => {
    await sync({
      stripeCustomerId: CUS,
      stripeSubscriptionId: SUB,
      // 故意把第二家店排在前面
      items: [
        { locationId: secondLoc, subscriptionItemId: ITEM_SECOND, plan: 'growth' },
        { locationId: SPA_LOC, subscriptionItemId: ITEM_MAIN, plan: 'essential' },
      ],
      subscriptionStatus: 'active',
    });

    expect((await accountOf(SPA_LOC)).plan).toBe('essential');
    expect((await accountOf(secondLoc)).plan).toBe('growth');
  });

  it('每家店记住自己的 subscription item id', async () => {
    await sync({
      stripeCustomerId: CUS, stripeSubscriptionId: SUB, subscriptionStatus: 'active',
      items: [
        { locationId: SPA_LOC, subscriptionItemId: ITEM_MAIN, plan: 'essential' },
        { locationId: secondLoc, subscriptionItemId: ITEM_SECOND, plan: 'growth' },
      ],
    });
    expect((await accountOf(SPA_LOC)).stripe_subscription_item_id).toBe(ITEM_MAIN);
    expect((await accountOf(secondLoc)).stripe_subscription_item_id).toBe(ITEM_SECOND);
  });

  it('续期清零对每家店各算各的账期', async () => {
    await withTenant({ orgId: SPA_ORG, locationId: secondLoc, membershipId: null }, (tx) => tx`
      update billing_accounts set included_credits_used = 400 where location_id = ${secondLoc}`);
    await withTenant(tenant, (tx) => tx`
      update billing_accounts set included_credits_used = 200 where location_id = ${SPA_LOC}`);

    await sync({
      stripeCustomerId: CUS, stripeSubscriptionId: SUB, subscriptionStatus: 'active',
      items: [
        // 主店往后走 = 续期；第二家店的账期没动 = 不清零
        { locationId: SPA_LOC, subscriptionItemId: ITEM_MAIN, plan: 'essential',
          currentPeriodEnd: '2026-10-01T00:00:00.000Z' },
        { locationId: secondLoc, subscriptionItemId: ITEM_SECOND, plan: 'growth',
          currentPeriodEnd: '2026-09-01T00:00:00.000Z' },
      ],
    });

    expect((await accountOf(SPA_LOC)).included_credits_used).toBe(0);
    expect((await accountOf(secondLoc)).included_credits_used).toBe(400);
  });

  it('别的 org 的门店不会被这条订阅带走', async () => {
    const NAIL_ORG = '11111111-1111-4111-8111-111111111111';
    const NAIL_LOC = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
    const before = await withTenant(
      { orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: null },
      (tx) => tx<{ status: string }[]>`
        select subscription_status as status from billing_accounts
        where location_id = ${NAIL_LOC}`);

    await sync({
      stripeCustomerId: CUS, stripeSubscriptionId: SUB, subscriptionStatus: 'canceled',
    });

    const after = await withTenant(
      { orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: null },
      (tx) => tx<{ status: string }[]>`
        select subscription_status as status from billing_accounts
        where location_id = ${NAIL_LOC}`);
    expect(after[0]?.status).toBe(before[0]?.status);
  });
});

describe('期末取消', () => {
  /**
   * ⭐ 老板在客户门户点「取消」，Stripe 给的是
   * `cancel_at_period_end = true` 而 **status 仍然是 active**。
   * 不镜像这两列的话，界面会一直显示「下次扣款 X 日」，
   * 直到那天突然全店冻结。
   */
  it('⭐ 镜像 cancel_at_period_end，且此时仍然可写', async () => {
    await sync({
      stripeCustomerId: CUS, stripeSubscriptionId: SUB, subscriptionStatus: 'active',
      cancelAtPeriodEnd: true, cancelAt: '2026-09-01T00:00:00.000Z',
    });

    const acct = await accountOf(SPA_LOC);
    expect(acct.cancel_at_period_end).toBe(true);
    expect(acct.subscription_status).toBe('active');

    const view = await withTenant(tenant, (tx) => loadBilling(tx, ctx));
    expect(view?.cancelAtPeriodEnd).toBe(true);
    expect(view?.cancelAt).toBe('2026-09-01T00:00:00.000Z');
  });

  it('恢复订阅时这一位要跟着回落', async () => {
    await sync({ subscriptionStatus: 'active', cancelAtPeriodEnd: true });
    await sync({ subscriptionStatus: 'active', cancelAtPeriodEnd: false, cancelAt: null });
    expect((await accountOf(SPA_LOC)).cancel_at_period_end).toBe(false);
  });

  it('期末取消同样广播给兄弟门店', async () => {
    await sync({
      stripeCustomerId: CUS, stripeSubscriptionId: SUB, subscriptionStatus: 'active',
      cancelAtPeriodEnd: true, cancelAt: '2026-09-01T00:00:00.000Z',
    });
    expect((await accountOf(secondLoc)).cancel_at_period_end).toBe(true);
  });
});

describe('从未接过计费的门店', () => {
  /**
   * ⭐ 默认状态原来是 `trialing`，而计费账户行会在任何一次记账时被自动
   * 建出来。于是一家从没进过 Stripe 的店按 essential 档白拿
   * 500 积分 + 60 语音分钟，而且 `current_period_end` 为空还永不清零。
   */
  it('⭐ subscription_status = none 时套餐内额度是 0', async () => {
    await withTenant({ orgId: SPA_ORG, locationId: secondLoc, membershipId: null }, (tx) => tx`
      update billing_accounts set
        subscription_status = 'none', stripe_subscription_id = null,
        stripe_customer_id = null, trial_ends_at = null, plan = 'essential'
      where location_id = ${secondLoc}`);

    const acct = await accountOf(secondLoc);
    expect(includedTotalOf(acct, 'credit')).toBe(0);
    expect(includedTotalOf(acct, 'voice_minute')).toBe(0);

    // 对照组：同一份账户行换成 active 就是整档套餐
    await withTenant({ orgId: SPA_ORG, locationId: secondLoc, membershipId: null }, (tx) => tx`
      update billing_accounts set subscription_status = 'active'
      where location_id = ${secondLoc}`);
    expect(includedTotalOf(await accountOf(secondLoc), 'credit'))
      .toBe(PLAN_QUOTAS.essential.credits);
  });

  it('none 不冻结写入 —— 店是真的，只是还没接上计费', async () => {
    await withTenant({ orgId: SPA_ORG, locationId: secondLoc, membershipId: null }, (tx) => tx`
      update billing_accounts set subscription_status = 'none'
      where location_id = ${secondLoc}`);

    await expect(dispatch('staff.setLocale', { locale: 'en' }, secondCtx,
      { idempotencyKey: crypto.randomUUID() })).resolves.toBeDefined();
  });

  it('none 的门店在账单页显示「未订阅」而不是「已订阅」', async () => {
    await withTenant({ orgId: SPA_ORG, locationId: secondLoc, membershipId: null }, (tx) => tx`
      update billing_accounts set
        subscription_status = 'none', stripe_subscription_id = null
      where location_id = ${secondLoc}`);

    const view = await withTenant(
      { orgId: SPA_ORG, locationId: secondLoc, membershipId: null },
      (tx) => loadBilling(tx, secondCtx));
    expect(view?.hasSubscription).toBe(false);
    expect(view?.quotas.every((q) => q.included.total === 0)).toBe(true);
  });

  /**
   * 退订之后 `stripe_subscription_id` 是**留着的**（webhook 靠它定位租户），
   * 所以「有没有订阅」不能只看那一列 —— 否则退订之后界面还是「已订阅」，
   * 老板找不到重新订阅的入口。
   */
  it('已取消的门店 hasSubscription 为 false，哪怕订阅 id 还留着', async () => {
    await sync({ subscriptionStatus: 'canceled' });
    const view = await withTenant(tenant, (tx) => loadBilling(tx, ctx));
    expect((await accountOf(SPA_LOC)).stripe_subscription_id).toBe(SUB);
    expect(view?.hasSubscription).toBe(false);
  });
});

describe('发票与冲销', () => {
  it('同一张 Stripe 发票只落一行，状态可以从 failed 改成 paid', async () => {
    const invoiceId = `in_lifecycle_${crypto.randomUUID().slice(0, 8)}`;
    const first = await dispatchSystem<{ invoiceId: string; alreadyRecorded: boolean }>(
      'billing.recordInvoice', {
        stripeInvoiceId: invoiceId, invoiceNumber: 'GF-0001',
        period: '2026-08-01 – 2026-08-31', description: 'GenieFront Essential',
        amountCents: 9900, status: 'failed', date: '2026-08-01',
      }, ctx);
    expect(first.result.alreadyRecorded).toBe(false);

    const second = await dispatchSystem<{ invoiceId: string; alreadyRecorded: boolean }>(
      'billing.recordInvoice', {
        stripeInvoiceId: invoiceId, invoiceNumber: 'GF-0001',
        period: '2026-08-01 – 2026-08-31', description: 'GenieFront Essential',
        amountCents: 9900, status: 'paid', date: '2026-08-01',
      }, ctx);
    expect(second.result.alreadyRecorded).toBe(true);
    expect(second.result.invoiceId).toBe(first.result.invoiceId);

    const [row] = await withTenant(tenant, (tx) => tx<{ status: string; n: string }[]>`
      select status, invoice_number as n from billing_invoices
      where stripe_invoice_id = ${invoiceId}`);
    expect(row!.status).toBe('paid');

    await withTenant(tenant, (tx) => tx`
      delete from billing_invoices where stripe_invoice_id = ${invoiceId}`);
  });

  /**
   * ⭐ 拒付不冲销的话，客户把钱要了回去而额度还留在账上 ——
   * 那是拿被盗的卡充值再拒付的标准玩法。
   */
  it('⭐ 退款写一条反向流水，不改原来那一行', async () => {
    const pi = `pi_lifecycle_${crypto.randomUUID().slice(0, 8)}`;
    await dispatchSystem('billing.recordTopup', {
      unit: 'credit', units: 1000, paidCents: 5000,
      stripePaymentIntentId: pi, trigger: 'manual',
    }, ctx, { idempotencyKey: `topup-${pi}` });

    const out = await dispatchSystem<{ reversed: boolean; units: number | null }>(
      'billing.recordTopupReversal', { stripePaymentIntentId: pi, reason: 'dispute' }, ctx);
    expect(out.result.reversed).toBe(true);
    expect(out.result.units).toBe(1000);

    const rows = await withTenant(tenant, (tx) => tx<{ kind: string; amount: number }[]>`
      select kind, amount from credit_ledger
      where stripe_payment_intent_id = ${pi} order by seq`);
    expect(rows.map((r) => r.kind)).toEqual(['topup', 'reversal']);
    expect(rows.map((r) => r.amount)).toEqual([1000, -1000]);

    // 同一笔再来一条（退款和拒付可能先后各发一条）不该再扣一次
    const again = await dispatchSystem<{ reversed: boolean }>(
      'billing.recordTopupReversal', { stripePaymentIntentId: pi, reason: 'refund' }, ctx);
    expect(again.result.reversed).toBe(false);
  });

  it('认不出对应充值时什么都不做 —— 凭空扣额度比不扣更糟', async () => {
    const out = await dispatchSystem<{ reversed: boolean }>(
      'billing.recordTopupReversal',
      { stripePaymentIntentId: 'pi_never_recorded_here', reason: 'refund' }, ctx);
    expect(out.result.reversed).toBe(false);
  });
});
