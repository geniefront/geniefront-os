/**
 * Phase 2 验收：Stripe 计费接线。
 *
 * 这一份里**没有一次真的 Stripe 调用** —— 扣款那一步是外部 IO，
 * 它的正确性由 `stripe listen` 打一条真事件来兜底（10-HANDOFF §3.A）。
 * 这里验的是钱到了我们这边之后发生的事，而那才是出错代价最大的部分：
 *
 *   · 同一笔扣款会不会入账两次（两条路都会来记：路由 + webhook）
 *   · 扣费会不会绕过账本直接改余额
 *   · 账本被就地改过能不能被发现
 *   · 并发续充会不会扣两次
 *   · 卡被拒几次之后会不会自动停手
 *   · 用量的单位是毫分还是分（差 10 倍的那个坑）
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { withTenant, closeDb } from '@gf/db';
import {
  creditsFor, MAX_TOPUP_FAILURES, PLAN_QUOTAS, TOPUP_UNITS, TRIAL_QUOTA,
} from '@gf/payroll';
import { buildContext } from './actor';
import { dispatch } from './bus';
import { loadBilling } from './queries/billing';
import { chargeQuota } from './billing/usage';
import { ensureAccount, appendLedger } from './handlers/billing';
import './handlers/billing';
/**
 * 闸门测试要一条**非 billing** 的命令来验证冻结确实生效。
 *
 * ⚠️ 用 `staff.setLocale` 而不是 `catalog.saveService`：后者会往共享的
 * 开发库里插一条新服务，而 money.test.ts 取的是「这家店最便宜的服务」
 * （`order by base_price_cents limit 1`）—— 一条 $10 的测试服务会让
 * 组单拆分那个用例的现金额超过小计，报「填充不接受负数」。
 * 跨文件的脏数据是最难查的一类失败，测试要选**不留痕**的命令。
 */
import './handlers/staff';
import { dispatchSystem } from './test/systemDispatch';

/**
 * 用足疗店（SPA）而不是美甲店：**只有 owner 有 `billing.manage`**，
 * 而种子数据里唯一的 owner 在这家店（美甲店那边最大的是 manager）。
 *
 * 这个「不方便」本身就是设计对了的信号 —— 计费是老板一个人的事，
 * 店长看不到账单（决策 19 的极致隐私）。
 */
const SPA_ORG = '22222222-2222-4222-8222-222222222222';
const SPA_LOC = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const tenant = { orgId: SPA_ORG, locationId: SPA_LOC, membershipId: null };

let ctx: Awaited<ReturnType<typeof buildContext>>;

const run = async <T>(name: string, input: unknown, key?: string): Promise<T> =>
  (await dispatch<T>(name, input, ctx, key ? { idempotencyKey: key } : {})).result;

/**
 * ⭐ 系统自有命令（AUD-01）。
 *
 * 计费状态的写入方在生产里是 **Stripe webhook / 扣款回执**，不是老板的浏览器。
 * 这个套件以前用上面那个 `run` 直接调 `billing.syncSubscription`，
 * 于是「老板能把自己写成 growth/active」在测试里看起来完全正常 ——
 * 那正是审计里那条 P0 一路绿灯的原因。
 *
 * 分成两个 helper 之后，「租户能不能调」重新变成一个可以被断言的问题，
 * 断言写在 `systemOnly.test.ts`。
 */
const runSystem = async <T>(name: string, input: unknown, key?: string): Promise<T> =>
  (await dispatchSystem<T>(name, input, ctx, key ? { idempotencyKey: key } : {})).result;

/**
 * 每个用例开头把账户复位。
 *
 * ⚠️ **余额要走账本清零，不能 `update balance_cents = 0`。**
 *
 * 这一份的第一版就是那么写的，结果 `ledgerBreakAt` 当场报了个断点 ——
 * 那不是测试写错了，是自洽性检查**正确地**发现了「有人绕过账本改了余额」，
 * 而且那个断点一旦写进开发库就永远消不掉（账本删不掉、改不动）。
 *
 * 正确的做法就是产品里冲账的做法：**写一条反向的 adjustment 记录**。
 * 于是这个 helper 顺带把「怎么冲账」演示了一遍。
 */
async function resetBilling(): Promise<void> {
  await withTenant(tenant, async (tx) => {
    await tx`update billing_accounts set
               auto_topup_enabled = false, auto_topup_failures = 0,
               last_auto_topup_at = null, default_payment_method_id = null,
               payment_method_label = null, subscription_status = 'trialing',
               plan = 'essential', stripe_customer_id = null, stripe_subscription_id = null,
               included_credits_used = 0, included_minutes_used = 0,
               auto_topup_credits_enabled = false, auto_topup_credits_failures = 0,
               auto_topup_credits_last_at = null,
               auto_topup_minutes_enabled = false, auto_topup_minutes_failures = 0,
               auto_topup_minutes_last_at = null,
               trial_ends_at = null, trial_will_end_notified_at = null
             where location_id = ${SPA_LOC}`;

    /**
     * ⚠️ 先**按账本把缓存修回来**，再走账本清零。顺序不能反。
     *
     * 这一步是第二次被咬出来的：下面那条「篡改余额缓存」的用例中途失败时，
     * 会把 999999 留在缓存里；如果这里直接对着 999999 写一条 −999999 的
     * adjustment，就等于**把污染写进了事实**，账本链条当场断掉，
     * 而账本删不掉改不动 —— 那个断点会永远留在开发库里。
     *
     * 缓存错了的正确修法永远是「按账本改缓存」，不是「往账本里补一笔」。
     */
    for (const unit of ['credit', 'voice_minute'] as const) {
      const col = unit === 'credit' ? 'credit_balance' : 'voice_minute_balance';
      const [sum] = await tx<{ n: number }[]>`
        select coalesce(sum(amount), 0)::int as n from credit_ledger
        where location_id = ${SPA_LOC} and unit = ${unit} and amount is not null`;
      await tx`update billing_accounts set ${tx(col)} = ${sum!.n}
               where location_id = ${SPA_LOC}`;

      const acct = await ensureAccount(tx, tenant, { forUpdate: true });
      const bal = unit === 'credit' ? acct.credit_balance : acct.voice_minute_balance;
      if (bal !== 0) {
        await appendLedger(tx, tenant, acct, {
          kind: 'adjustment', unit, amount: -bal,
          reason: '测试复位',  // adjustment 必须写原因，没有原因的调账是查不清的账
        });
      }
    }
  });
}

/** 从视图里取某一种额度 */
async function quota(unit: 'credit' | 'voice_minute') {
  const view = await withTenant(tenant, (tx) => loadBilling(tx, ctx));
  return view!.quotas.find((q) => q.unit === unit)!;
}

beforeAll(async () => {
  const [m] = await withTenant(tenant, (tx) => tx<{ id: string; user_id: string }[]>`
    select m.id, m.user_id from memberships m
    join membership_roles mr on mr.membership_id = m.id
    join roles r on r.id = mr.role_id
    where m.location_id = ${SPA_LOC} and m.status = 'active'
      and r.key = 'owner' limit 1`);
  ctx = await buildContext({ userId: m!.user_id, membershipId: m!.id });

  // 账户不存在时第一条命令会自动建（试用期的店也会产生 AI 用量）
  await run('billing.setAutoTopup', {
    unit: 'credit', enabled: false, thresholdUnits: 50,
  });
  await resetBilling();
});

afterAll(async () => {
  await resetBilling();
  await closeDb();
});

// ─────────────────────────────────────────────────────────────────── 账户

describe('账户自动建立', () => {
  it('⭐ 从没进过 Stripe 的店也有账户 —— 不然用量发生了却记不了账', async () => {
    // 「余额不足就拒绝记账」的做法会导致：用量照常发生、账上却看不到，
    // 到月底突然冒出一笔对不上的差额，那时候谁也说不清是哪几次调用
    const view = await withTenant(tenant, (tx) => loadBilling(tx, ctx));
    expect(view).not.toBeNull();
    expect(view!.plan).toBe('essential');
    expect(view!.subscriptionStatus).toBe('trialing');
    // 两种额度各一份，**永远是两份** —— 合成一个「总额度」就会被套利
    expect(view!.quotas.map((q) => q.unit)).toEqual(['credit', 'voice_minute']);
  });
});

// ─────────────────────────────────────────────────────────────── 用量扣费

describe('用量扣费', () => {
  it('⭐ 1 积分 = $0.01 的真实成本，向上取整', () => {
    // 实测（05 §6.0）：只读回答 $0.003、带工具 $0.010、复杂提案 $0.034
    expect(creditsFor(292)).toBe(1);
    expect(creditsFor(1020)).toBe(2);
    // 拍照开店走 Opus，一张 $0.08 → 8 积分，不用为它单独定规则
    expect(creditsFor(8000)).toBe(8);
  });

  /** 把某一种套餐内额度用满，之后的调用才会扣充值余额 */
  async function exhaust(unit: 'credit' | 'voice_minute') {
    const col = unit === 'credit' ? 'included_credits_used' : 'included_minutes_used';
    await withTenant(tenant, (tx) => tx`
      update billing_accounts set ${tx(col)} = 99999 where location_id = ${SPA_LOC}`);
  }

  it('⭐ 先用套餐里的 —— 额度没用完，充值余额一个都不扣', async () => {
    await resetBilling();
    const out = await withTenant(tenant, (tx) => chargeQuota(tx, ctx, {
      unit: 'credit', amount: 4,
    }));
    expect(out).toMatchObject({ fromIncluded: 4, fromBalance: 0, ledgerId: null });

    const q = await quota('credit');
    expect(q.balance).toBe(0);                       // 一个都没扣
    expect(q.included.used).toBe(4);
    expect(q.included.total).toBe(PLAN_QUOTAS.essential.credits);
  });

  it('⭐ 一次可以跨两边扣 —— 别浪费掉最后那几个额度', async () => {
    await resetBilling();
    // 套餐内剩 3 个，这次要 8 个 → 3 个走额度 + 5 个走余额
    await withTenant(tenant, (tx) => tx`
      update billing_accounts set included_credits_used = ${PLAN_QUOTAS.essential.credits - 3}
      where location_id = ${SPA_LOC}`);

    const out = await withTenant(tenant, (tx) => chargeQuota(tx, ctx, {
      unit: 'credit', amount: 8,
    }));
    expect(out).toMatchObject({ fromIncluded: 3, fromBalance: 5 });
    expect((await quota('credit')).balance).toBe(-5);
  });

  it('⭐ 积分和分钟是两本独立的账 —— 扣积分不动分钟', async () => {
    await resetBilling();
    await exhaust('credit');
    await withTenant(tenant, (tx) => chargeQuota(tx, ctx, { unit: 'credit', amount: 10 }));

    expect((await quota('credit')).balance).toBe(-10);
    // 决策 8：一分钟电话的成本是一次副驾的 6.2 倍，能换就会被套利
    expect((await quota('voice_minute')).balance).toBe(0);
    expect((await quota('voice_minute')).included.used).toBe(0);
  });

  it('语音走自己那本账', async () => {
    await resetBilling();
    const out = await withTenant(tenant, (tx) => chargeQuota(tx, ctx, {
      unit: 'voice_minute', amount: 70,
    }));
    // Essential 含 60 分钟 → 60 走额度、10 走余额
    expect(out).toMatchObject({ fromIncluded: 60, fromBalance: 10 });
    expect((await quota('voice_minute')).balance).toBe(-10);
    expect((await quota('credit')).balance).toBe(0);
  });

  it('⭐ 余额允许扣成负数 —— 调用已经发生了，拒绝记账不会把它变没', async () => {
    await resetBilling();
    await exhaust('credit');
    for (let i = 0; i < 3; i++) {
      await withTenant(tenant, (tx) => chargeQuota(tx, ctx, { unit: 'credit', amount: 100 }));
    }
    const q = await quota('credit');
    expect(q.balance).toBe(-300);
    expect(q.ledgerBreakAt).toBeNull();
  });

  it('扣 0 个不记账本', async () => {
    const out = await withTenant(tenant, (tx) => chargeQuota(tx, ctx, {
      unit: 'credit', amount: 0,
    }));
    expect(out).toBeNull();
  });

  it('⭐ 并发扣费不会在账本上留下断点', async () => {
    await resetBilling();
    await exhaust('credit');
    // 不加 for update 的话，两笔并发会各自读到同一个余额，
    // balance_after 就对不齐了 —— 而对账时这看起来像是有人篡改
    await Promise.all(Array.from({ length: 5 }, () =>
      withTenant(tenant, (tx) => chargeQuota(tx, ctx, { unit: 'credit', amount: 3 }))));

    const q = await quota('credit');
    expect(q.ledgerBreakAt).toBeNull();
    expect(q.balance).toBe(-15);
  });
});

// ─────────────────────────────────────────────────────────────────── 充值

describe('充值入账', () => {
  it('⭐ 同一个 PaymentIntent 只入账一次 —— 路由和 webhook 都会来记这一笔', async () => {
    await resetBilling();
    const pi = `pi_test_${Date.now()}`;
    const body = {
      unit: 'credit', units: TOPUP_UNITS.credit, paidCents: 5000,
      stripePaymentIntentId: pi, trigger: 'manual',
    };

    const a = await runSystem<{ balanceAfter: number; alreadyRecorded: boolean }>(
      'billing.recordTopup', body, `topup-${pi}`);
    expect(a).toMatchObject({ alreadyRecorded: false, balanceAfter: 1000 });

    // webhook 那条路会用一个不同的幂等键走同一条命令 ——
    // 总线的幂等挡不住它，所以命令自己按 PaymentIntent 再去一次重
    const b = await runSystem<{ balanceAfter: number; alreadyRecorded: boolean }>(
      'billing.recordTopup', body, `webhook-${pi}`);
    expect(b).toMatchObject({ alreadyRecorded: true, balanceAfter: 1000 });

    expect((await quota('credit')).balance).toBe(1000);   // 没有变成 2000
  });

  it('⭐ 充分钟不会加到积分上', async () => {
    await resetBilling();
    const pi = `pi_min_${Date.now()}`;
    await runSystem('billing.recordTopup', {
      unit: 'voice_minute', units: TOPUP_UNITS.voice_minute, paidCents: 5000,
      stripePaymentIntentId: pi, trigger: 'manual',
    }, `topup-${pi}`);

    expect((await quota('voice_minute')).balance).toBe(200);
    expect((await quota('credit')).balance).toBe(0);
  });

  it('充值把那一种额度的失败计数清零 —— 这张卡现在是好的', async () => {
    await resetBilling();
    await runSystem('billing.recordTopupFailure', { unit: 'credit', reason: 'card_declined' });
    const pi = `pi_ok_${Date.now()}`;
    await runSystem('billing.recordTopup', {
      unit: 'credit', units: 1000, paidCents: 5000,
      stripePaymentIntentId: pi, trigger: 'auto',
    }, `topup-${pi}`);
    expect((await quota('credit')).autoTopup.failures).toBe(0);
  });

  it('充值数量必须为正 —— 「充值 −1000」不能混进账本', async () => {
    await expect(runSystem('billing.recordTopup', {
      unit: 'credit', units: -1000, paidCents: 5000,
      stripePaymentIntentId: null, trigger: 'manual',
    }, `bad-${Date.now()}`)).rejects.toThrow();
  });
});

// ───────────────────────────────────────────────────────────────── 自动续充

describe('自动续充', () => {
  /** 把某一种额度摆成「该充了」的样子：套餐内用完 + 余额低 + 有卡 */
  async function arm(unit: 'credit' | 'voice_minute'): Promise<void> {
    await resetBilling();
    await runSystem('billing.savePaymentMethod',
      { paymentMethodId: 'pm_test_4242', label: 'Visa ···· 4242' });
    const col = unit === 'credit' ? 'included_credits_used' : 'included_minutes_used';
    await withTenant(tenant, (tx) => tx`
      update billing_accounts set stripe_customer_id = 'cus_test', ${tx(col)} = 99999
      where location_id = ${SPA_LOC}`);
    await run('billing.setAutoTopup', { unit, enabled: true, thresholdUnits: 50 });
  }

  it('该充的时候认领成功', async () => {
    await arm('credit');
    const claim = await runSystem<{ charge: boolean; units: number | null; priceCents: number | null }>(
      'billing.claimAutoTopup', { unit: 'credit' });
    expect(claim).toMatchObject({ charge: true, units: 1000, priceCents: 5000 });
  });

  it('⭐ 套餐内还有额度就不充 —— 否则刚续期的账户会被白扣一笔 $50', async () => {
    await resetBilling();
    await runSystem('billing.savePaymentMethod', { paymentMethodId: 'pm_x', label: 'Visa' });
    await withTenant(tenant, (tx) => tx`
      update billing_accounts set stripe_customer_id = 'cus_test'
      where location_id = ${SPA_LOC}`);
    await run('billing.setAutoTopup', { unit: 'credit', enabled: true, thresholdUnits: 50 });

    const claim = await runSystem<{ charge: boolean; reason: string | null }>(
      'billing.claimAutoTopup', { unit: 'credit' });
    expect(claim).toMatchObject({ charge: false, reason: 'included_remaining' });
  });

  it('⭐ 认领一次之后进冷却 —— 不然一晚上能触发几十次扣款尝试', async () => {
    await arm('credit');
    await runSystem('billing.claimAutoTopup', { unit: 'credit' });
    const second = await runSystem<{ charge: boolean; reason: string | null }>(
      'billing.claimAutoTopup', { unit: 'credit' });
    expect(second).toMatchObject({ charge: false, reason: 'cooling_down' });
  });

  it('⭐ 并发认领只有一个成功 —— 否则老板一分钟内被扣两次 $50', async () => {
    await arm('credit');
    const results = await Promise.all(Array.from({ length: 4 }, () =>
      runSystem<{ charge: boolean }>('billing.claimAutoTopup', { unit: 'credit' })));
    expect(results.filter((r) => r.charge)).toHaveLength(1);
  });

  it('⭐ 两种额度的冷却互不影响 —— 各充各的', async () => {
    await arm('credit');
    // 分钟那一边也摆好
    await withTenant(tenant, (tx) => tx`
      update billing_accounts set included_minutes_used = 99999
      where location_id = ${SPA_LOC}`);
    await run('billing.setAutoTopup',
      { unit: 'voice_minute', enabled: true, thresholdUnits: 20 });

    await runSystem('billing.claimAutoTopup', { unit: 'credit' });      // 积分进冷却
    const minutes = await runSystem<{ charge: boolean; units: number | null }>(
      'billing.claimAutoTopup', { unit: 'voice_minute' });
    expect(minutes).toMatchObject({ charge: true, units: 200 });   // 分钟不受影响
  });

  it('没绑卡 → 不充，且说得出为什么', async () => {
    await resetBilling();
    await withTenant(tenant, (tx) => tx`
      update billing_accounts set included_credits_used = 99999
      where location_id = ${SPA_LOC}`);
    await run('billing.setAutoTopup', { unit: 'credit', enabled: true, thresholdUnits: 50 });
    const claim = await runSystem<{ charge: boolean; reason: string | null }>(
      'billing.claimAutoTopup', { unit: 'credit' });
    expect(claim).toMatchObject({ charge: false, reason: 'no_payment_method' });
  });

  it('⭐ 订阅停了就不再充值', async () => {
    await arm('credit');
    await runSystem('billing.syncSubscription', { subscriptionStatus: 'canceled' });
    const claim = await runSystem<{ charge: boolean; reason: string | null }>(
      'billing.claimAutoTopup', { unit: 'credit' });
    // 客户已经在走流失流程，这时候扣他一笔 $50 是最容易变成投诉和拒付的操作
    expect(claim).toMatchObject({ charge: false, reason: 'subscription_inactive' });
  });

  it('⭐ 连续失败到上限就自动关掉 —— 银行看到连续被拒会把卡冻了', async () => {
    await arm('credit');
    let last = { failures: 0, disabled: false };
    for (let i = 0; i < MAX_TOPUP_FAILURES; i++) {
      last = await runSystem('billing.recordTopupFailure', { unit: 'credit', reason: 'card_declined' });
    }
    expect(last.disabled).toBe(true);
    expect((await quota('credit')).autoTopup.enabled).toBe(false);
    // 分钟那一边不受牵连
    expect((await quota('voice_minute')).autoTopup.failures).toBe(0);
  });

  it('⭐ 重新打开时清零失败计数 —— 老板刚换了卡，不该还被旧卡的失败挡着', async () => {
    await arm('credit');
    for (let i = 0; i < MAX_TOPUP_FAILURES; i++) {
      await runSystem('billing.recordTopupFailure', { unit: 'credit', reason: 'card_declined' });
    }
    const out = await run<{ failuresReset: boolean }>('billing.setAutoTopup',
      { unit: 'credit', enabled: true, thresholdUnits: 80 });
    expect(out.failuresReset).toBe(true);
    expect((await quota('credit')).autoTopup.failures).toBe(0);
  });

  it('换一张卡把两种额度的失败计数都清零', async () => {
    await arm('credit');
    await runSystem('billing.recordTopupFailure', { unit: 'credit', reason: 'expired_card' });
    await runSystem('billing.recordTopupFailure', { unit: 'voice_minute', reason: 'expired_card' });
    await runSystem('billing.savePaymentMethod',
      { paymentMethodId: 'pm_test_5555', label: 'Mastercard ···· 5555' });
    expect((await quota('credit')).autoTopup.failures).toBe(0);
    expect((await quota('voice_minute')).autoTopup.failures).toBe(0);
  });

  it('阈值超出范围直接拒 —— 任意值会引来拿被盗的卡试活的人', async () => {
    await expect(run('billing.setAutoTopup',
      { unit: 'credit', enabled: true, thresholdUnits: 999999 })).rejects.toThrow();
  });
});

// ───────────────────────────────────────────────────────────────── 订阅同步

describe('订阅同步', () => {
  it('局部更新：这次不知道的字段不动', async () => {
    await resetBilling();
    await runSystem('billing.syncSubscription',
      { stripeCustomerId: 'cus_x', plan: 'growth', subscriptionStatus: 'active' });
    // 建 Checkout 时那次同步只带 customerId —— 不能把套餐和状态抹回默认值
    await runSystem('billing.syncSubscription', { stripeCustomerId: 'cus_x' });

    const view = await withTenant(tenant, (tx) => loadBilling(tx, ctx));
    expect(view!.plan).toBe('growth');
    expect(view!.subscriptionStatus).toBe('active');
  });

  it('⭐ 续期把套餐内额度清零 —— 时机跟着 Stripe 走，不自己数日子', async () => {
    await resetBilling();
    const t0 = new Date(Date.now() + 30 * 86400_000).toISOString();
    await runSystem('billing.syncSubscription',
      { subscriptionStatus: 'active', currentPeriodEnd: t0 });

    // 用掉一些额度
    await withTenant(tenant, (tx) => tx`
      update billing_accounts set included_credits_used = 123, included_minutes_used = 45
      where location_id = ${SPA_LOC}`);

    // 续期：period_end 往后走
    const t1 = new Date(Date.now() + 60 * 86400_000).toISOString();
    await runSystem('billing.syncSubscription',
      { subscriptionStatus: 'active', currentPeriodEnd: t1 });

    expect((await quota('credit')).included.used).toBe(0);
    expect((await quota('voice_minute')).included.used).toBe(0);
  });

  it('⭐ 重投的旧事件不清零 —— 那等于白送客户一整期额度', async () => {
    await resetBilling();
    const late = new Date(Date.now() + 60 * 86400_000).toISOString();
    await runSystem('billing.syncSubscription',
      { subscriptionStatus: 'active', currentPeriodEnd: late });
    await withTenant(tenant, (tx) => tx`
      update billing_accounts set included_credits_used = 77
      where location_id = ${SPA_LOC}`);

    // Stripe 偶尔重投一条更早的事件。照着它清零就是白送一期
    const early = new Date(Date.now() + 30 * 86400_000).toISOString();
    await runSystem('billing.syncSubscription',
      { subscriptionStatus: 'active', currentPeriodEnd: early });

    expect((await quota('credit')).included.used).toBe(77);
  });

  it('⭐ 认不出的 price 传 null → 套餐保持不变，不会被静默降档', async () => {
    await resetBilling();
    await runSystem('billing.syncSubscription', { plan: 'growth', subscriptionStatus: 'active' });
    // planForPriceId 认不出来时返回 null。写成 essential 的话，
    // 一个付 Growth 钱的客户会被降档，而账单上看不出来
    await runSystem('billing.syncSubscription', { plan: null, subscriptionStatus: 'active' });

    const view = await withTenant(tenant, (tx) => loadBilling(tx, ctx));
    expect(view!.plan).toBe('growth');
  });
});

// ───────────────────────────────────────────────────────────── 账本不可篡改

describe('七天免费试用（批 1）', () => {
  const inDays = (n: number) => new Date(Date.now() + n * 86400_000).toISOString();

  it('试用期内额度按 TRIAL_QUOTA 算，不是套餐额度', async () => {
    await resetBilling();
    await runSystem('billing.syncSubscription', {
      subscriptionStatus: 'trialing', plan: 'growth', trialEndsAt: inDays(5),
    });

    // ⭐ 套餐是 growth（1200 积分 / 500 分钟），但试用期只给试用额度。
    // 显示成 growth 的量、实际扣到 150 就没了，那是最难解释的一种账
    const view = await withTenant(tenant, (tx) => loadBilling(tx, ctx));
    expect(view!.trialing).toBe(true);
    expect(view!.plan).toBe('growth');
    expect((await quota('credit')).included.total).toBe(TRIAL_QUOTA.credits);
    expect((await quota('voice_minute')).included.total).toBe(TRIAL_QUOTA.voiceMinutes);
  });

  it('⭐ 试用到期那一刻起按套餐额度算 —— 判据是时间不是 status', async () => {
    await resetBilling();
    // status 还留在 trialing（webhook 还没回来），但 trial_ends_at 已经过去了
    await runSystem('billing.syncSubscription', {
      subscriptionStatus: 'trialing', plan: 'growth', trialEndsAt: inDays(-1),
    });

    const view = await withTenant(tenant, (tx) => loadBilling(tx, ctx));
    expect(view!.trialing).toBe(false);
    expect((await quota('credit')).included.total).toBe(PLAN_QUOTAS.growth.credits);
  });

  it('转正时 trialEndsAt 传 null → 真的写回 null，不留旧值', async () => {
    await resetBilling();
    await runSystem('billing.syncSubscription', { subscriptionStatus: 'trialing', trialEndsAt: inDays(3) });
    expect((await withTenant(tenant, (tx) => loadBilling(tx, ctx)))!.trialEndsAt).not.toBeNull();

    // Stripe 扣款成功之后订阅上就没有 trial_end 了
    await runSystem('billing.syncSubscription', { subscriptionStatus: 'active', trialEndsAt: null });

    const view = await withTenant(tenant, (tx) => loadBilling(tx, ctx));
    expect(view!.trialEndsAt).toBeNull();
    expect(view!.trialing).toBe(false);
  });

  it('不带 trialEndsAt 的局部更新不动它 —— 建 Checkout 那次只带 customerId', async () => {
    await resetBilling();
    const end = inDays(4);
    await runSystem('billing.syncSubscription', { subscriptionStatus: 'trialing', trialEndsAt: end });
    await runSystem('billing.syncSubscription', { stripeCustomerId: 'cus_trial' });

    expect((await withTenant(tenant, (tx) => loadBilling(tx, ctx)))!.trialing).toBe(true);
  });

  it('⭐ 换了一段试用 → 提醒信的去重标记清掉，新的那段还能再发一封', async () => {
    await resetBilling();
    await runSystem('billing.syncSubscription', { subscriptionStatus: 'trialing', trialEndsAt: inDays(3) });
    await withTenant(tenant, (tx) => tx`
      update billing_accounts set trial_will_end_notified_at = now()
      where location_id = ${SPA_LOC}`);

    // 到期时间变了 = 这是另一段试用
    await runSystem('billing.syncSubscription', { subscriptionStatus: 'trialing', trialEndsAt: inDays(9) });

    const [row] = await withTenant(tenant, (tx) => tx<{ n: Date | null }[]>`
      select trial_will_end_notified_at as n from billing_accounts
      where location_id = ${SPA_LOC}`);
    expect(row!.n).toBeNull();
  });

  it('到期时间没变 → 去重标记保留，不会重复发信', async () => {
    await resetBilling();
    const end = inDays(3);
    await runSystem('billing.syncSubscription', { subscriptionStatus: 'trialing', trialEndsAt: end });
    await withTenant(tenant, (tx) => tx`
      update billing_accounts set trial_will_end_notified_at = now()
      where location_id = ${SPA_LOC}`);

    // Stripe 重投同一条事件
    await runSystem('billing.syncSubscription', { subscriptionStatus: 'trialing', trialEndsAt: end });

    const [row] = await withTenant(tenant, (tx) => tx<{ n: Date | null }[]>`
      select trial_will_end_notified_at as n from billing_accounts
      where location_id = ${SPA_LOC}`);
    expect(row!.n).not.toBeNull();
  });
});

describe('欠费冻结写入（批 1）', () => {
  /** 把订阅状态直接压到某个值 —— 绕开命令，因为命令本身就是被测对象 */
  const setStatus = (s: string) => withTenant(tenant, (tx) => tx`
    update billing_accounts set subscription_status = ${s} where location_id = ${SPA_LOC}`);

  it('⭐ past_due 时普通写操作被拒，错误码是 SUBSCRIPTION_PAST_DUE', async () => {
    await resetBilling();
    await setStatus('past_due');

    await expect(run('staff.setLocale', { locale: 'en' }))
      .rejects.toMatchObject({ code: 'SUBSCRIPTION_PAST_DUE' });

    await resetBilling();
  });

  it('⭐ 但 billing.* 照样放行 —— 否则老板换了卡也救不回来', async () => {
    await resetBilling();
    await setStatus('past_due');

    // 这一条必须能过：它是唯一的自救通道
    await runSystem('billing.syncSubscription', { subscriptionStatus: 'active' });

    const view = await withTenant(tenant, (tx) => loadBilling(tx, ctx));
    expect(view!.subscriptionStatus).toBe('active');
  });

  it('trialing 和 active 都放行', async () => {
    for (const s of ['trialing', 'active']) {
      await resetBilling();
      await setStatus(s);
      await expect(run('staff.setLocale', { locale: 'en' })).resolves.toBeTruthy();
    }
    await resetBilling();
  });

  it('canceled 也冻 —— 退订之后数据保留、只读可用', async () => {
    await resetBilling();
    await setStatus('canceled');
    await expect(run('staff.setLocale', { locale: 'en' }))
      .rejects.toMatchObject({ code: 'SUBSCRIPTION_PAST_DUE' });
    await resetBilling();
  });
});

// ─────────────────────────────────────────────── 本地命令不得发明付费状态

describe('本地命令不得发明付费状态（P0-1 / P0-2）', () => {
  const setStatus = (s: string) => withTenant(tenant, (tx) => tx`
    update billing_accounts set subscription_status = ${s} where location_id = ${SPA_LOC}`);

  const refuse = { code: 'UPSTREAM_UNAVAILABLE', details: { reason: 'use_checkout_or_portal' } };

  async function snapshotPaidState() {
    return withTenant(tenant, async (tx) => {
      const [acct] = await tx<{
        plan: string;
        subscription_status: string;
        billing_cycle: string;
        credit_balance: number;
        voice_minute_balance: number;
        included_credits_used: number;
        included_minutes_used: number;
      }[]>`
        select plan, subscription_status, billing_cycle,
               credit_balance, voice_minute_balance,
               included_credits_used, included_minutes_used
        from billing_accounts where location_id = ${SPA_LOC}`;
      const invoices = await tx<{ id: string; status: string; invoice_number: string }[]>`
        select id, status, invoice_number from billing_invoices
        where location_id = ${SPA_LOC} order by id`;
      const ledger = await tx<{ id: string; kind: string; unit: string; amount: number }[]>`
        select id, kind, unit, amount from credit_ledger
        where location_id = ${SPA_LOC} order by id`;
      const view = await loadBilling(tx, ctx);
      const credit = view!.quotas.find((q) => q.unit === 'credit')!;
      const voice = view!.quotas.find((q) => q.unit === 'voice_minute')!;
      return {
        plan: acct!.plan,
        subscriptionStatus: acct!.subscription_status,
        billingCycle: acct!.billing_cycle,
        creditBalance: acct!.credit_balance,
        voiceMinuteBalance: acct!.voice_minute_balance,
        includedCreditsUsed: acct!.included_credits_used,
        includedMinutesUsed: acct!.included_minutes_used,
        invoices,
        ledger,
        entitlement: {
          plan: view!.plan,
          subscriptionStatus: view!.subscriptionStatus,
          credit: {
            includedTotal: credit.included.total,
            includedUsed: credit.included.used,
            includedRemaining: credit.included.remaining,
            balance: credit.balance,
          },
          voice: {
            includedTotal: voice.included.total,
            includedUsed: voice.included.used,
            includedRemaining: voice.included.remaining,
            balance: voice.balance,
          },
        },
      };
    });
  }

  it('billing.changePlan 不能改 plan / subscription_status / invoices / 额度', async () => {
    await resetBilling();
    const before = await snapshotPaidState();

    await expect(runSystem('billing.changePlan', {
      targetPlan: 'growth',
      billingCycle: 'monthly',
    })).rejects.toMatchObject(refuse);

    expect(await snapshotPaidState()).toEqual(before);
    expect(before.plan).toBe('essential');
    expect(before.subscriptionStatus).toBe('trialing');
  });

  it('past_due 不能靠 billing.changePlan 变成 active', async () => {
    await resetBilling();
    await setStatus('past_due');
    const before = await snapshotPaidState();
    expect(before.subscriptionStatus).toBe('past_due');

    await expect(runSystem('billing.changePlan', {
      targetPlan: 'growth',
      billingCycle: 'monthly',
    })).rejects.toMatchObject(refuse);

    const after = await snapshotPaidState();
    expect(after).toEqual(before);
    expect(after.subscriptionStatus).toBe('past_due');
  });

  it('billing.buyAddon 不能改积分 / 语音余额、账本或发票', async () => {
    await resetBilling();
    const before = await snapshotPaidState();

    await expect(runSystem('billing.buyAddon', {
      addonType: 'voice_minutes_100',
      priceCents: 2500,
    })).rejects.toMatchObject(refuse);

    await expect(runSystem('billing.buyAddon', {
      addonType: 'copilot_credits_500',
      priceCents: 4900,
    })).rejects.toMatchObject(refuse);

    expect(await snapshotPaidState()).toEqual(before);
    expect(before.creditBalance).toBe(0);
    expect(before.voiceMinuteBalance).toBe(0);
  });

  it('past_due 不能靠 billing.buyAddon 拿到单位', async () => {
    await resetBilling();
    await setStatus('past_due');
    const before = await snapshotPaidState();

    await expect(runSystem('billing.buyAddon', {
      addonType: 'marketing_sms_1000',
      priceCents: 3900,
    })).rejects.toMatchObject(refuse);

    const after = await snapshotPaidState();
    expect(after).toEqual(before);
    expect(after.creditBalance).toBe(before.creditBalance);
    expect(after.voiceMinuteBalance).toBe(before.voiceMinuteBalance);
    expect(after.ledger).toEqual(before.ledger);
  });

  it('Stripe 回写路径仍然有效：syncSubscription 与 recordTopup', async () => {
    await resetBilling();
    const essentialIncluded = (await quota('credit')).included.total;

    await runSystem('billing.syncSubscription', {
      plan: 'growth',
      subscriptionStatus: 'active',
      stripeCustomerId: 'cus_p0_batch1',
      stripeSubscriptionId: 'sub_p0_batch1',
    });

    const afterSync = await withTenant(tenant, (tx) => loadBilling(tx, ctx));
    expect(afterSync!.plan).toBe('growth');
    expect(afterSync!.subscriptionStatus).toBe('active');
    expect(afterSync!.quotas.find((q) => q.unit === 'credit')!.included.total)
      .toBeGreaterThan(essentialIncluded);

    const pi = `pi_p0_${Date.now()}`;
    const topup = await runSystem<{ balanceAfter: number; alreadyRecorded: boolean }>(
      'billing.recordTopup',
      {
        unit: 'credit', units: TOPUP_UNITS.credit, paidCents: 5000,
        stripePaymentIntentId: pi, trigger: 'manual',
      },
      `topup-${pi}`,
    );
    expect(topup).toMatchObject({ alreadyRecorded: false, balanceAfter: 1000 });
    expect((await quota('credit')).balance).toBe(1000);
    expect((await quota('voice_minute')).balance).toBe(0);

    await runSystem('billing.syncSubscription', { subscriptionStatus: 'past_due' });
    expect((await withTenant(tenant, (tx) => loadBilling(tx, ctx)))!.subscriptionStatus)
      .toBe('past_due');
    await runSystem('billing.syncSubscription', { subscriptionStatus: 'active' });
    expect((await withTenant(tenant, (tx) => loadBilling(tx, ctx)))!.subscriptionStatus)
      .toBe('active');
  });
});

describe('账本只追加（宪法第 9 条）', () => {
  it('⭐ app_user 改不动已经写下的账本行', async () => {
    await resetBilling();
    const pi = `pi_lock_${Date.now()}`;
    await runSystem('billing.recordTopup', {
      unit: 'credit', units: 1000, paidCents: 5000,
      stripePaymentIntentId: pi, trigger: 'manual',
    }, `topup-${pi}`);

    // 「为什么少了 200 积分」这个问题，只有在账本不可改的前提下才答得出来
    await expect(withTenant(tenant, (tx) => tx`
      update credit_ledger set amount = 999999
      where location_id = ${SPA_LOC}`)).rejects.toThrow();
  });

  it('⭐ 删也删不掉', async () => {
    await expect(withTenant(tenant, (tx) => tx`
      delete from credit_ledger where location_id = ${SPA_LOC}`)).rejects.toThrow();
  });

  it('⭐ 绕过账本直接改余额缓存会被自洽性检查发现', async () => {
    // ⚠️ 这一条**必须放在最后**：它故意把余额缓存改坏，
    // 而后面任何一个断言余额的用例都会跟着一起红。
    await resetBilling();
    const good = (await quota('credit')).balance;
    await withTenant(tenant, (tx) => tx`
      update billing_accounts set credit_balance = 999999
      where location_id = ${SPA_LOC}`);

    try {
      const q = await quota('credit');
      expect(q.balance).toBe(999999);
      // ⚠️ `ledgerBreakAt` **抓不到这一种** —— 账本一行没动，它自己是自洽的，
      // 只是没人再看它了。「绕过账本改余额」和「改账本行」是两件事，要两条检查
      expect(q.ledgerBreakAt).toBeNull();
      expect(q.balanceMismatch).toEqual({ cached: 999999, ledger: good });
      // 分钟那本账不受牵连
      expect((await quota('voice_minute')).balanceMismatch).toBeNull();
    } finally {
      // ⚠️ 必须在 finally 里修回去。断言失败时把 999999 留在库里的话，
      // 下一次 resetBilling 会对着它写调账，污染就进了账本 —— 而账本改不动
      await withTenant(tenant, (tx) => tx`
        update billing_accounts set credit_balance = ${good}
        where location_id = ${SPA_LOC}`);
    }

    const fixed = await quota('credit');
    expect(fixed.ledgerBreakAt).toBeNull();
    expect(fixed.balanceMismatch).toBeNull();
  });
});
