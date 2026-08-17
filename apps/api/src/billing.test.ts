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
import { usageChargeCents, MAX_TOPUP_FAILURES } from '@gf/payroll';
import { buildContext } from './actor';
import { dispatch } from './bus';
import { loadBilling } from './queries/billing';
import { chargeUsage } from './billing/usage';
import { ensureAccount, appendLedger } from './handlers/billing';
import './handlers/billing';

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
               plan = 'essential', included_assists_used = 0, stripe_customer_id = null, stripe_subscription_id = null
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
    const [sum] = await tx<{ n: number }[]>`
      select coalesce(sum(amount_cents), 0)::int as n from credit_ledger
      where location_id = ${SPA_LOC}`;
    await tx`update billing_accounts set balance_cents = ${sum!.n}
             where location_id = ${SPA_LOC}`;

    const acct = await ensureAccount(tx, tenant, { forUpdate: true });
    if (acct.balance_cents !== 0) {
      await appendLedger(tx, tenant, acct, {
        kind: 'adjustment',
        amountCents: -acct.balance_cents,
        reason: '测试复位',   // adjustment 必须写原因，没有原因的调账是查不清的账
      });
    }
  });
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
    enabled: false, thresholdCents: 1000, amountCents: 10000,
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
  });
});

// ─────────────────────────────────────────────────────────────── 用量扣费

describe('用量扣费', () => {
  it('⭐ 单位是毫分不是分 —— 传错一位数账单差 10 倍', async () => {
    // $0.012 的一次副驾调用 = 1.2 分 = 1200 毫分。
    // 加价 3.0x 之后是 3600 毫分 = 3.6 分，向上取整 4 分。
    // 传成 12000 的话是 36 分 —— 数字看起来完全正常，这是最难发现的一类错
    expect(usageChargeCents(1200, 'ai_assist')).toBe(4);
    expect(usageChargeCents(12000, 'ai_assist')).toBe(36);
  });

  /** 把套餐内额度用满，之后的调用才会扣余额 */
  async function exhaustIncluded(): Promise<void> {
    await withTenant(tenant, (tx) => tx`
      update billing_accounts set included_assists_used = 99999
      where location_id = ${SPA_LOC}`);
  }

  it('⭐ 先用套餐里的 —— 额度没用完不扣一分钱', async () => {
    await resetBilling();
    const out = await withTenant(tenant, (tx) => chargeUsage(tx, ctx, {
      kind: 'ai_assist', costMillicents: 2400,
    }));
    expect(out).toMatchObject({ source: 'included', chargedCents: 0, ledgerId: null });

    const view = await withTenant(tenant, (tx) => loadBilling(tx, ctx));
    expect(view!.balanceCents).toBe(0);          // 一分钱没扣
    expect(view!.included.used).toBe(1);
    expect(view!.included.remaining).toBe(view!.included.total - 1);
  });

  it('⭐ 电话分钟不吃副驾的额度（决策 8：合成一个额度必被套利）', async () => {
    await resetBilling();
    // 单价还没实测，成本 0 → 直接跳过；关键是它没有去动 included 计数
    const out = await withTenant(tenant, (tx) => chargeUsage(tx, ctx, {
      kind: 'ai_call_min', costMillicents: 0,
    }));
    expect(out).toBeNull();
    const view = await withTenant(tenant, (tx) => loadBilling(tx, ctx));
    expect(view!.included.used).toBe(0);
  });

  it('扣费走账本，余额缓存跟着账本走', async () => {
    await resetBilling();
    await exhaustIncluded();
    const out = await withTenant(tenant, (tx) => chargeUsage(tx, ctx, {
      kind: 'ai_assist', costMillicents: 2400,
    }));
    expect(out).not.toBeNull();
    expect(out!.chargedCents).toBe(usageChargeCents(2400, 'ai_assist'));

    const view = await withTenant(tenant, (tx) => loadBilling(tx, ctx));
    // ⚠️ 余额是账本算出来的，billing_accounts.balance_cents 只是缓存。
    // 两者对不上说明有人绕过账本改了余额 —— 那是要当事故查的
    expect(view!.balanceCents).toBe(out!.balanceAfterCents);
    expect(view!.balanceCents).toBe(-out!.chargedCents);
    expect(view!.ledgerBreakAt).toBeNull();
  });

  it('⭐ 余额允许扣成负数 —— 调用已经发生了，拒绝记账不会把它变没', async () => {
    await resetBilling();
    await exhaustIncluded();
    // 相反的做法（余额不足就拒绝扣费）会导致用量照常发生、账上却看不到
    for (let i = 0; i < 3; i++) {
      await withTenant(tenant, (tx) => chargeUsage(tx, ctx, {
        kind: 'ai_assist', costMillicents: 100_000,
      }));
    }
    const view = await withTenant(tenant, (tx) => loadBilling(tx, ctx));
    expect(view!.balanceCents).toBeLessThan(0);
    expect(view!.ledgerBreakAt).toBeNull();
  });

  it('⭐ 成本为 0 不记账本 —— 电话单价还没实测，别刷一堆 $0.00 流水', async () => {
    // ai_call_min 现在的 cost_cents 恒为 0（09 §6）。记一堆 0 元流水
    // 只会把老板要看的那几笔真扣费淹掉
    const out = await withTenant(tenant, (tx) => chargeUsage(tx, ctx, {
      kind: 'ai_call_min', costMillicents: 0,
    }));
    expect(out).toBeNull();
  });

  it('⭐ 并发扣费不会在账本上留下断点', async () => {
    await resetBilling();
    await exhaustIncluded();
    // 不加 for update 的话，两笔并发会各自读到同一个余额，
    // balance_after 就对不齐了 —— 而对账时这看起来像是有人篡改
    await Promise.all(Array.from({ length: 5 }, () =>
      withTenant(tenant, (tx) => chargeUsage(tx, ctx, {
        kind: 'ai_assist', costMillicents: 2400,
      }))));

    const view = await withTenant(tenant, (tx) => loadBilling(tx, ctx));
    expect(view!.ledgerBreakAt).toBeNull();
    expect(view!.balanceCents).toBe(-5 * usageChargeCents(2400, 'ai_assist'));
  });
});

// ─────────────────────────────────────────────────────────────────── 充值

describe('充值入账', () => {
  it('⭐ 同一个 PaymentIntent 只入账一次 —— 路由和 webhook 都会来记这一笔', async () => {
    await resetBilling();
    const pi = `pi_test_${Date.now()}`;

    const a = await run<{ balanceAfterCents: number; alreadyRecorded: boolean }>(
      'billing.recordTopup',
      { amountCents: 5000, stripePaymentIntentId: pi, trigger: 'manual' },
      `topup-${pi}`);
    expect(a.alreadyRecorded).toBe(false);
    expect(a.balanceAfterCents).toBe(5000);

    // webhook 那条路会用一个不同的幂等键走同一条命令 ——
    // 总线的幂等挡不住它，所以命令自己按 PaymentIntent 再去一次重
    const b = await run<{ balanceAfterCents: number; alreadyRecorded: boolean }>(
      'billing.recordTopup',
      { amountCents: 5000, stripePaymentIntentId: pi, trigger: 'manual' },
      `webhook-${pi}`);
    expect(b.alreadyRecorded).toBe(true);
    expect(b.balanceAfterCents).toBe(5000);   // 没有变成 10000

    const view = await withTenant(tenant, (tx) => loadBilling(tx, ctx));
    expect(view!.balanceCents).toBe(5000);
  });

  it('充值把失败计数清零 —— 这张卡现在是好的', async () => {
    await resetBilling();
    await run('billing.recordTopupFailure', { reason: 'card_declined' });
    const pi = `pi_ok_${Date.now()}`;
    await run('billing.recordTopup',
      { amountCents: 5000, stripePaymentIntentId: pi, trigger: 'auto' }, `topup-${pi}`);

    const view = await withTenant(tenant, (tx) => loadBilling(tx, ctx));
    expect(view!.autoTopup.failures).toBe(0);
  });

  it('充值金额必须为正 —— 「充值 −$50」不能混进账本', async () => {
    await expect(run('billing.recordTopup',
      { amountCents: -5000, stripePaymentIntentId: null, trigger: 'manual' },
      `bad-${Date.now()}`)).rejects.toThrow();
  });
});

// ───────────────────────────────────────────────────────────────── 自动续充

describe('自动续充', () => {
  /** 把账户摆成「该充了」的样子 */
  async function armAutoTopup(): Promise<void> {
    await resetBilling();
    await run('billing.savePaymentMethod',
      { paymentMethodId: 'pm_test_4242', label: 'Visa ···· 4242' });
    await withTenant(tenant, (tx) => tx`
      update billing_accounts set stripe_customer_id = 'cus_test'
      where location_id = ${SPA_LOC}`);
    await run('billing.setAutoTopup',
      { enabled: true, thresholdCents: 1000, amountCents: 10000 });
  }

  it('余额低于阈值 + 有卡 + 订阅正常 → 认领成功', async () => {
    await armAutoTopup();
    const claim = await run<{ charge: boolean; amountCents: number | null }>(
      'billing.claimAutoTopup', {});
    expect(claim.charge).toBe(true);
    expect(claim.amountCents).toBe(10000);
  });

  it('⭐ 认领一次之后进冷却 —— 不然一晚上能触发几十次扣款尝试', async () => {
    await armAutoTopup();
    await run('billing.claimAutoTopup', {});
    const second = await run<{ charge: boolean; reason: string | null }>(
      'billing.claimAutoTopup', {});
    expect(second.charge).toBe(false);
    expect(second.reason).toBe('cooling_down');
  });

  it('⭐ 并发认领只有一个成功 —— 否则老板一分钟内被扣两次 $50', async () => {
    await armAutoTopup();
    const results = await Promise.all(Array.from({ length: 4 }, () =>
      run<{ charge: boolean }>('billing.claimAutoTopup', {})));
    expect(results.filter((r) => r.charge)).toHaveLength(1);
  });

  it('没绑卡 → 不充，且说得出为什么', async () => {
    await resetBilling();
    await run('billing.setAutoTopup',
      { enabled: true, thresholdCents: 1000, amountCents: 10000 });
    const claim = await run<{ charge: boolean; reason: string | null }>(
      'billing.claimAutoTopup', {});
    expect(claim).toMatchObject({ charge: false, reason: 'no_payment_method' });
  });

  it('⭐ 订阅停了就不再往余额里充钱', async () => {
    await armAutoTopup();
    await run('billing.syncSubscription', { subscriptionStatus: 'canceled' });
    const claim = await run<{ charge: boolean; reason: string | null }>(
      'billing.claimAutoTopup', {});
    // 客户已经在走流失流程，这时候扣他一笔 $50 是最容易变成投诉和拒付的操作
    expect(claim).toMatchObject({ charge: false, reason: 'subscription_inactive' });
  });

  it('⭐ 连续失败到上限就自动关掉 —— 银行看到连续被拒会把卡冻了', async () => {
    await armAutoTopup();
    let last = { failures: 0, disabled: false };
    for (let i = 0; i < MAX_TOPUP_FAILURES; i++) {
      last = await run('billing.recordTopupFailure', { reason: 'card_declined' });
    }
    expect(last.disabled).toBe(true);

    const view = await withTenant(tenant, (tx) => loadBilling(tx, ctx));
    expect(view!.autoTopup.enabled).toBe(false);
  });

  it('⭐ 重新打开时清零失败计数 —— 老板刚换了卡，不该还被旧卡的失败挡着', async () => {
    await armAutoTopup();
    for (let i = 0; i < MAX_TOPUP_FAILURES; i++) {
      await run('billing.recordTopupFailure', { reason: 'card_declined' });
    }
    const out = await run<{ failuresReset: boolean }>('billing.setAutoTopup',
      { enabled: true, thresholdCents: 2000, amountCents: 10000 });
    expect(out.failuresReset).toBe(true);

    const view = await withTenant(tenant, (tx) => loadBilling(tx, ctx));
    expect(view!.autoTopup.failures).toBe(0);
  });

  it('换一张卡也清零失败计数', async () => {
    await armAutoTopup();
    await run('billing.recordTopupFailure', { reason: 'expired_card' });
    await run('billing.savePaymentMethod',
      { paymentMethodId: 'pm_test_5555', label: 'Mastercard ···· 5555' });
    const view = await withTenant(tenant, (tx) => loadBilling(tx, ctx));
    expect(view!.autoTopup.failures).toBe(0);
  });

  it('⭐ 自动续充不接受 $20 那一档 —— 忙店一个月要被扣 1.5 次', async () => {
    // $20 是留给「第一次买，先试试水」的手动充值。
    // 拿它做自动续充，每次扣款都是客户账单上的一条记录
    await expect(run('billing.setAutoTopup',
      { enabled: true, thresholdCents: 1000, amountCents: 2000 })).rejects.toThrow();
    // 任意金额更不行 —— 那会引来拿被盗的卡试活的人
    await expect(run('billing.setAutoTopup',
      { enabled: true, thresholdCents: 1000, amountCents: 777 })).rejects.toThrow();
    // $50 可以
    const ok = await run<{ amountCents: number }>('billing.setAutoTopup',
      { enabled: true, thresholdCents: 1000, amountCents: 5000 });
    expect(ok.amountCents).toBe(5000);
  });
});

// ───────────────────────────────────────────────────────────────── 订阅同步

describe('订阅同步', () => {
  it('局部更新：这次不知道的字段不动', async () => {
    await resetBilling();
    await run('billing.syncSubscription',
      { stripeCustomerId: 'cus_x', plan: 'growth', subscriptionStatus: 'active' });
    // 建 Checkout 时那次同步只带 customerId —— 不能把套餐和状态抹回默认值
    await run('billing.syncSubscription', { stripeCustomerId: 'cus_x' });

    const view = await withTenant(tenant, (tx) => loadBilling(tx, ctx));
    expect(view!.plan).toBe('growth');
    expect(view!.subscriptionStatus).toBe('active');
  });

  it('⭐ 续期把套餐内额度清零 —— 时机跟着 Stripe 走，不自己数日子', async () => {
    await resetBilling();
    const t0 = new Date(Date.now() + 30 * 86400_000).toISOString();
    await run('billing.syncSubscription',
      { subscriptionStatus: 'active', currentPeriodEnd: t0 });

    // 用掉一些额度
    await withTenant(tenant, (tx) => tx`
      update billing_accounts set included_assists_used = 123
      where location_id = ${SPA_LOC}`);

    // 续期：period_end 往后走
    const t1 = new Date(Date.now() + 60 * 86400_000).toISOString();
    await run('billing.syncSubscription',
      { subscriptionStatus: 'active', currentPeriodEnd: t1 });

    const view = await withTenant(tenant, (tx) => loadBilling(tx, ctx));
    expect(view!.included.used).toBe(0);
    expect(view!.included.remaining).toBe(view!.included.total);
  });

  it('⭐ 重投的旧事件不清零 —— 那等于白送客户一整期额度', async () => {
    await resetBilling();
    const late = new Date(Date.now() + 60 * 86400_000).toISOString();
    await run('billing.syncSubscription',
      { subscriptionStatus: 'active', currentPeriodEnd: late });
    await withTenant(tenant, (tx) => tx`
      update billing_accounts set included_assists_used = 77
      where location_id = ${SPA_LOC}`);

    // Stripe 偶尔重投一条更早的事件。照着它清零就是白送一期
    const early = new Date(Date.now() + 30 * 86400_000).toISOString();
    await run('billing.syncSubscription',
      { subscriptionStatus: 'active', currentPeriodEnd: early });

    const view = await withTenant(tenant, (tx) => loadBilling(tx, ctx));
    expect(view!.included.used).toBe(77);
  });

  it('⭐ 认不出的 price 传 null → 套餐保持不变，不会被静默降档', async () => {
    await resetBilling();
    await run('billing.syncSubscription', { plan: 'growth', subscriptionStatus: 'active' });
    // planForPriceId 认不出来时返回 null。写成 essential 的话，
    // 一个付 Growth 钱的客户会被降档，而账单上看不出来
    await run('billing.syncSubscription', { plan: null, subscriptionStatus: 'active' });

    const view = await withTenant(tenant, (tx) => loadBilling(tx, ctx));
    expect(view!.plan).toBe('growth');
  });
});

// ───────────────────────────────────────────────────────────── 账本不可篡改

describe('账本只追加（宪法第 9 条）', () => {
  it('⭐ app_user 改不动已经写下的账本行', async () => {
    await resetBilling();
    const pi = `pi_lock_${Date.now()}`;
    await run('billing.recordTopup',
      { amountCents: 5000, stripePaymentIntentId: pi, trigger: 'manual' }, `topup-${pi}`);

    // 「为什么少了 $12」这个问题，只有在账本不可改的前提下才答得出来
    await expect(withTenant(tenant, (tx) => tx`
      update credit_ledger set amount_cents = 999999
      where location_id = ${SPA_LOC}`)).rejects.toThrow();
  });

  it('⭐ 删也删不掉', async () => {
    await expect(withTenant(tenant, (tx) => tx`
      delete from credit_ledger where location_id = ${SPA_LOC}`)).rejects.toThrow();
  });

  it('⭐ 绕过账本直接改余额会被自洽性检查当场发现', async () => {
    // ⚠️ 这一条**必须放在最后**：它故意把余额缓存改坏，
    // 而后面任何一个断言余额的用例都会跟着一起红。
    //
    // 这不是假设出来的场景 —— 这一份测试的第一版就是靠
    // `update billing_accounts set balance_cents = 0` 来做清理的，
    // 而检查当场把它报成了断点。既然它连我们自己都拦得住，就说明它是活的。
    const view0 = await withTenant(tenant, (tx) => loadBilling(tx, ctx));
    const good = view0!.balanceCents;
    await withTenant(tenant, (tx) => tx`
      update billing_accounts set balance_cents = 999999
      where location_id = ${SPA_LOC}`);

    try {
      const view = await withTenant(tenant, (tx) => loadBilling(tx, ctx));
      expect(view!.balanceCents).toBe(999999);
      // ⚠️ `ledgerBreakAt` **抓不到这一种** —— 账本一行没动，它自己是自洽的，
      // 只是没人再看它了。这正是第一版漏掉的那个口子：
      // 「绕过账本改余额」和「改账本行」是两件事，要两条检查
      expect(view!.ledgerBreakAt).toBeNull();
      expect(view!.balanceMismatch).toEqual({ cachedCents: 999999, ledgerCents: good });
    } finally {
      // ⚠️ 必须在 finally 里修回去。断言失败时把 999999 留在库里的话，
      // 下一次 resetBilling 会对着它写调账，污染就进了账本 —— 而账本改不动
      await withTenant(tenant, (tx) => tx`
        update billing_accounts set balance_cents = ${good}
        where location_id = ${SPA_LOC}`);
    }

    const fixed = await withTenant(tenant, (tx) => loadBilling(tx, ctx));
    expect(fixed!.ledgerBreakAt).toBeNull();
    expect(fixed!.balanceMismatch).toBeNull();
  });
});
