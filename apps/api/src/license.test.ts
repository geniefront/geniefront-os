/**
 * 订阅码：Stripe 之外的第二条计费权威（sql/0120，计划批 1–6）
 *
 * 这一份验的是**最容易漏、而且漏了不报错**的那几件事：
 *
 *   · 续期是叠加而不是覆盖（覆盖 = 没收客户已经付过的天数）
 *   · 一张码只生效一次，失败原因永不外泄（否则接口成了枚举探针）
 *   · Stripe 权威与订阅码权威互斥，且 webhook 不会静默改回来
 *   · 到期冻结写入、读照常，而**兑换本身在冻结时仍然可用**
 *   · 额度包走的是同一本账（对账逻辑一行都不用改）
 *   · 签发限 super_admin —— support 能看不能发
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { AppError, ERROR_CODES } from '@gf/contracts';
import {
  closeDb, withTenant, PLATFORM_OPS_USER_ID, PLATFORM_SUPPORT_USER_ID,
} from '@gf/db';
import { buildContext } from './actor';
import { dispatch } from './bus';
import { loadBilling } from './queries/billing';
import { loadBillingInvoices } from './queries/billingInvoices';
import { dispatchSystem } from './test/systemDispatch';
import { runLicenseSweep } from './ops/licenseSweep';
import './handlers/billing';
import './handlers/license';
/** 冻结闸门要一条**非 billing** 的命令来验证。理由同 billing.test.ts：选不留痕的 */
import './handlers/staff';

const SPA_ORG = '22222222-2222-4222-8222-222222222222';
const SPA_LOC = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const NAIL_LOC = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const tenant = { orgId: SPA_ORG, locationId: SPA_LOC, membershipId: null };

const authUser = { userId: '' as string, email: undefined as string | undefined };

vi.mock('./auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./auth')>();
  return {
    ...actual,
    verifyAccessToken: vi.fn(async () => {
      if (!authUser.userId) throw new AppError(ERROR_CODES.UNAUTHENTICATED);
      return { userId: authUser.userId, email: authUser.email };
    }),
  };
});

const { buildServer } = await import('./server');

let app: ReturnType<typeof buildServer>;
let ctx: Awaited<ReturnType<typeof buildContext>>;

const asOps = (): void => { authUser.userId = PLATFORM_OPS_USER_ID; };
/**
 * ⚠️ 用**活着的** support（种子里的 `support@maildrop.cc`），
 * 不是被撤销的那个 `exops` —— 后者会撞在更早的一道门上
 * （`not_platform_operator`），于是「support 能看不能发」这条根本没被验到。
 */
const asSupport = (): void => { authUser.userId = PLATFORM_SUPPORT_USER_ID; };

beforeAll(async () => {
  const [m] = await withTenant(tenant, (tx) => tx<{ id: string; user_id: string }[]>`
    select m.id, m.user_id from memberships m
    join membership_roles mr on mr.membership_id = m.id
    join roles r on r.id = mr.role_id
    where m.location_id = ${SPA_LOC} and m.status = 'active'
      and r.key = 'owner' limit 1`);
  ctx = await buildContext({ userId: m!.user_id, membershipId: m!.id });

  app = buildServer();
  await app.ready();
});

afterAll(async () => {
  if (app) await app.close();
  await closeDb();
});

/** 把 SPA 的计费账户复位成「从没接过计费」 */
async function resetAccount(): Promise<void> {
  await withTenant(tenant, (tx) => tx`
    update billing_accounts set
      billing_source = 'none', license_period_end = null, license_code_id = null,
      license_expiry_notified_at = null,
      subscription_status = 'none', plan = 'essential',
      stripe_customer_id = null, stripe_subscription_id = null,
      stripe_subscription_item_id = null,
      current_period_end = null, cancel_at_period_end = false, cancel_at = null,
      trial_ends_at = null, included_credits_used = 0, included_minutes_used = 0,
      included_period_start = null
    where location_id = ${SPA_LOC}`);
}

interface Acct {
  billing_source: string;
  subscription_status: string;
  plan: string;
  license_period_end: string | null;
  current_period_end: string | null;
  license_code_id: string | null;
  included_credits_used: number;
}

const acct = async (locationId = SPA_LOC): Promise<Acct> => {
  const [row] = await withTenant(
    { orgId: SPA_ORG, locationId, membershipId: null },
    (tx) => tx<Acct[]>`
      select billing_source, subscription_status, plan,
             license_period_end::text as license_period_end,
             current_period_end::text as current_period_end,
             license_code_id, included_credits_used
      from billing_accounts where location_id = ${locationId}`);
  return row!;
};

const daysFromNow = (iso: string | null): number => {
  if (iso === null) throw new Error('到期时刻为空');
  const t = new Date(iso.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00')).getTime();
  return (t - Date.now()) / 86_400_000;
};

/** 用运营台签发一张码，返回明文（明文只在这一次响应里出现） */
async function issue(body: Record<string, unknown>): Promise<{
  status: number; code: string; codeId: string; body: Record<string, unknown>;
}> {
  asOps();
  const r = await app.inject({ method: 'POST', url: '/v1/platform/licenses', payload: body });
  const j = r.json() as Record<string, unknown>;
  return {
    status: r.statusCode,
    code: (j['code'] as string) ?? '',
    codeId: (j['codeId'] as string) ?? '',
    body: j,
  };
}

const redeem = async (code: string): Promise<Record<string, unknown>> =>
  (await dispatch('billing.redeemCode', { code }, ctx)).result as Record<string, unknown>;

beforeEach(resetAccount);

// ══════════════════════════════════════════════════════════ 签发与兑换

describe('订阅码 · 签发与兑换', () => {
  it('签发的响应里带明文码，而且库里存的是 hash（明文一次都不落库）', async () => {
    const out = await issue({
      kind: 'subscription', plan: 'growth', durationDays: 30,
      paymentNote: 'wechat 2026-09-09 ¥1500',
    });
    expect(out.status).toBe(200);
    expect(out.code).toMatch(/^GF-[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}$/);

    // 列表里只有前缀，没有明文
    asOps();
    const list = await app.inject({ method: 'GET', url: '/v1/platform/licenses?q=GF-' });
    const items = (list.json() as { items: Array<Record<string, unknown>> }).items;
    const mine = items.find((i) => i['codeId'] === out.codeId)!;
    expect(mine['codePrefix']).toBe(out.code.slice(0, 7));
    expect(JSON.stringify(items)).not.toContain(out.code);
  });

  it('兑换订阅码 → 权威变 license、状态 active、到期 30 天后', async () => {
    const { code } = await issue({
      kind: 'subscription', plan: 'growth', durationDays: 30, paymentNote: 'alipay',
    });
    const res = await redeem(code);
    expect(res['kind']).toBe('subscription');
    expect(res['plan']).toBe('growth');

    const a = await acct();
    expect(a.billing_source).toBe('license');
    expect(a.subscription_status).toBe('active');
    expect(a.plan).toBe('growth');
    expect(daysFromNow(a.license_period_end)).toBeGreaterThan(29.9);
    expect(daysFromNow(a.license_period_end)).toBeLessThan(30.1);
    // ⭐ 两列镜像同一个值：展示逻辑不必为第二种权威分叉
    expect(a.current_period_end).toBe(a.license_period_end);
  });

  /**
   * ⭐ 这一条是整份里最容易写错、而且错了最晚才被发现的。
   *
   * 提前续费的店最常见：还剩 10 天时又转了一笔钱。覆盖式实现会把那 10 天
   * 没收掉，而老板要到到期那天才发现 —— 那时我们已经无法解释。
   */
  it('续期是叠加不是覆盖：剩 10 天时兑 30 天码 = 40 天', async () => {
    const first = await issue({
      kind: 'subscription', plan: 'essential', durationDays: 10, paymentNote: 'wechat #1',
    });
    await redeem(first.code);
    expect(daysFromNow((await acct()).license_period_end)).toBeLessThan(10.1);

    const second = await issue({
      kind: 'subscription', plan: 'essential', durationDays: 30, paymentNote: 'wechat #2',
    });
    await redeem(second.code);
    const days = daysFromNow((await acct()).license_period_end);
    expect(days).toBeGreaterThan(39.9);
    expect(days).toBeLessThan(40.1);
  });

  it('额度包码走的是同一本账：账本 +500，余额缓存跟着走，对账不断链', async () => {
    const before = await withTenant(tenant, (tx) => loadBilling(tx, ctx));
    const beforeCredit = before!.quotas.find((q) => q.unit === 'credit')!.balance;

    const { code } = await issue({
      kind: 'quota_pack', unit: 'credit', amount: 500, amountCents: 5000,
      paymentNote: 'wechat 额度包',
    });
    const res = await redeem(code);
    expect(res['unit']).toBe('credit');
    expect(res['amount']).toBe(500);
    expect(res['balanceAfter']).toBe(beforeCredit + 500);
    // 额度包不改权威 —— 它只往账本里加一笔
    expect(res['periodEnd']).toBeNull();
    expect((await acct()).billing_source).toBe('none');

    const view = await withTenant(tenant, (tx) => loadBilling(tx, ctx));
    const credit = view!.quotas.find((q) => q.unit === 'credit')!;
    expect(credit.balance).toBe(beforeCredit + 500);
    expect(credit.ledgerBreakAt).toBeNull();
    expect(credit.balanceMismatch).toBeNull();
  });

  it('大小写、分隔符、以及 O/0 与 I/1 混读都能兑（电话里报码必然发生）', async () => {
    const { code } = await issue({
      kind: 'subscription', plan: 'essential', durationDays: 7, paymentNote: 'phone dictation',
    });
    const mangled = code.toLowerCase().replace(/-/g, ' ')
      .replace(/0/g, 'O').replace(/1/g, 'l');
    const res = await redeem(mangled);
    expect(res['kind']).toBe('subscription');
  });
});

// ══════════════════════════════════════════════════════════ 私下收款的发票

/**
 * 走 Stripe 的店，发票页是 webhook 落下来的。私下付款的店在那一页上
 * 什么都没有 —— 而「上个月那 ¥1500 有没有单据」是老板年底做账一定会问的。
 */
describe('订阅码 · 私下收款也留一行发票', () => {
  const invoices = async (): Promise<Array<{
    invoiceNumber: string; description: string; amountCents: number;
    status: string; period: string;
  }>> => {
    const out = await withTenant(tenant, (tx) => loadBillingInvoices(tx, ctx));
    return out.invoices;
  };

  it('订阅码带面值 → 一行 paid 发票，号码认得出是哪张码', async () => {
    const before = (await invoices()).length;
    const { code, codeId } = await issue({
      kind: 'subscription', plan: 'growth', durationDays: 90,
      amountCents: 450000, paymentNote: 'wechat 2026-09-09 ¥4500 张老板代付',
    });
    const res = await redeem(code);
    expect(res['invoiceId']).toBeTruthy();

    const list = await invoices();
    expect(list.length).toBe(before + 1);
    const row = list[0]!;
    expect(row.amountCents).toBe(450000);
    expect(row.status).toBe('paid');
    expect(row.invoiceNumber).toBe(`LIC-${codeId.replace(/-/g, '').slice(0, 8).toUpperCase()}`);
    // 账期写成「今天 – 到期日」，老板能对上他买的那 90 天
    expect(row.period).toContain('–');

    /*
     * ⭐ 正文里**不能出现运营的内部收款说明**。
     * 「张老板代付」这类话收件人是我们自己，搬到店主看得见的发票列表上
     * 迟早会泄露一句不该他看到的话。
     */
    expect(row.description).not.toContain('张老板');
    expect(row.description).not.toContain('wechat');
    expect(row.description).toContain('Growth');
    expect(row.description).toContain('90');
  });

  it('额度包带面值 → 发票正文写清买了多少额度，账期只写当天（不过期）', async () => {
    const { code } = await issue({
      kind: 'quota_pack', unit: 'voice_minute', amount: 200,
      amountCents: 5000, paymentNote: 'alipay 分钟包',
    });
    await redeem(code);
    const row = (await invoices())[0]!;
    expect(row.amountCents).toBe(5000);
    expect(row.description).toContain('200');
    expect(row.period).not.toContain('–');
  });

  it('没写面值的码（补偿性赠送）不写发票 —— 没收到钱就不该有单据', async () => {
    const before = (await invoices()).length;
    const { code } = await issue({
      kind: 'subscription', plan: 'essential', durationDays: 14,
      paymentNote: '故障补偿，未收费',
    });
    const res = await redeem(code);
    expect(res['invoiceId']).toBeNull();
    expect((await invoices()).length).toBe(before);
  });

  it('运营代挂额度也留发票（四条路走的是同一个函数）', async () => {
    const before = (await invoices()).length;
    asOps();
    const r = await app.inject({
      method: 'POST', url: `/v1/platform/stores/${SPA_LOC}/license/apply`,
      headers: { 'idempotency-key': randomUUID() },
      payload: {
        kind: 'subscription', plan: 'essential', durationDays: 30,
        amountCents: 9900, paymentNote: 'zelle $99',
      },
    });
    expect(r.statusCode).toBe(200);
    const list = await invoices();
    expect(list.length).toBe(before + 1);
    expect(list[0]!.amountCents).toBe(9900);
  });
});

// ══════════════════════════════════════════════════════ 失败一律同一句话

describe('订阅码 · 失败原因永不外泄', () => {
  const expectInvalid = async (code: string): Promise<void> => {
    await expect(redeem(code)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { reason: 'code_invalid' },
    });
  };

  it('不存在的码', async () => {
    await expectInvalid('GF-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ');
  });

  it('已经兑过的码（第二次）', async () => {
    const { code } = await issue({
      kind: 'subscription', plan: 'essential', durationDays: 7, paymentNote: 'once',
    });
    await redeem(code);
    await expectInvalid(code);
  });

  it('被撤销的码', async () => {
    const { code, codeId } = await issue({
      kind: 'subscription', plan: 'essential', durationDays: 7, paymentNote: 'to revoke',
    });
    asOps();
    const rev = await app.inject({
      method: 'POST', url: `/v1/platform/licenses/${codeId}/revoke`,
      payload: { reason: '发错人了' },
    });
    expect(rev.statusCode).toBe(200);
    await expectInvalid(code);
  });

  it('定向给别家门店的码', async () => {
    const { code } = await issue({
      kind: 'subscription', plan: 'essential', durationDays: 7,
      paymentNote: 'targeted elsewhere', targetLocationId: NAIL_LOC,
    });
    await expectInvalid(code);
  });

  /**
   * 「过了可兑换期限」那一档的断言在 `@gf/db` 的 `licenseCodes.migration.test.ts`
   * 里 —— 拨动 `valid_until` 需要 postgres 身份，而 `apps/**` 一律不许 import
   * `admin.ts`（lint-guards 第 3 条）。放在这里只能靠等一天，那不是一个
   * 可执行的测试步骤。
   */

  it('撤销一张已经兑过的码 → 400，而且不动那一行历史', async () => {
    const { code, codeId } = await issue({
      kind: 'subscription', plan: 'essential', durationDays: 7, paymentNote: 'used',
    });
    await redeem(code);
    asOps();
    const rev = await app.inject({
      method: 'POST', url: `/v1/platform/licenses/${codeId}/revoke`,
      payload: { reason: '想收回' },
    });
    expect(rev.statusCode).toBe(400);
    expect(rev.json().details.reason).toBe('license_already_redeemed');
  });
});

// ══════════════════════════════════════════════════════════ 两个权威互斥

describe('订阅码 · 与 Stripe 权威互斥', () => {
  /** 把这一行伪装成「正在被 Stripe 按月扣款」 */
  const onStripe = async (): Promise<void> => {
    await withTenant(tenant, (tx) => tx`
      update billing_accounts set
        billing_source = 'stripe', subscription_status = 'active',
        stripe_customer_id = 'cus_license_test',
        stripe_subscription_id = 'sub_license_test',
        stripe_subscription_item_id = 'si_license_test',
        current_period_end = now() + interval '20 days'
      where location_id = ${SPA_LOC}`);
  };

  it('Stripe 还在收费时，订阅码拒绝生效（否则双重收费）', async () => {
    await onStripe();
    const { code } = await issue({
      kind: 'subscription', plan: 'growth', durationDays: 30, paymentNote: 'conflict',
    });
    await expect(redeem(code)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { reason: 'stripe_active_switch_required' },
    });
    expect((await acct()).billing_source).toBe('stripe');
  });

  it('额度包**不受**权威约束：Stripe 订阅的店照样能用现金买语音分钟', async () => {
    await onStripe();
    const { code } = await issue({
      kind: 'quota_pack', unit: 'voice_minute', amount: 200, amountCents: 5000,
      paymentNote: 'cash minutes',
    });
    const res = await redeem(code);
    expect(res['amount']).toBe(200);
    expect((await acct()).billing_source).toBe('stripe');
  });

  /**
   * ⭐⭐ 这一条是计划里标的最高风险点。
   *
   * 退订后 `stripe_subscription_id` 是留着的（webhook 靠它定位租户），
   * 所以一家已经改用订阅码的店仍然会被同一条订阅的事件扫到。
   * 没有跳过判断的话，表现是「明明续到年底，某天早上突然显示欠费」。
   */
  it('老订阅的后续事件不会把 license 行改回去', async () => {
    const { code } = await issue({
      kind: 'subscription', plan: 'growth', durationDays: 365, paymentNote: 'switched',
    });
    await redeem(code);
    // 模拟「切换时保留下来的那条 Stripe 订阅 id」
    await withTenant(tenant, (tx) => tx`
      update billing_accounts set stripe_subscription_id = 'sub_old_kept'
      where location_id = ${SPA_LOC}`);
    const before = await acct();

    await dispatchSystem('billing.syncSubscription', {
      stripeCustomerId: 'cus_old',
      stripeSubscriptionId: 'sub_old_kept',
      plan: 'essential',
      subscriptionStatus: 'past_due',
      currentPeriodEnd: new Date(Date.now() + 86_400_000).toISOString(),
    }, ctx);

    const after = await acct();
    expect(after.billing_source).toBe('license');
    expect(after.subscription_status).toBe('active');
    expect(after.plan).toBe('growth');
    expect(after.license_period_end).toBe(before.license_period_end);
  });

  it('老板自己回去走了一次 Checkout（新订阅 id）→ 权威交回 Stripe', async () => {
    const { code } = await issue({
      kind: 'subscription', plan: 'growth', durationDays: 365, paymentNote: 'will resubscribe',
    });
    await redeem(code);

    await dispatchSystem('billing.syncSubscription', {
      stripeCustomerId: 'cus_new',
      stripeSubscriptionId: 'sub_brand_new',
      plan: 'essential',
      subscriptionStatus: 'active',
      currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    }, ctx);

    const after = await acct();
    expect(after.billing_source).toBe('stripe');
    expect(after.subscription_status).toBe('active');
    expect(after.plan).toBe('essential');
  });
});

// ══════════════════════════════════════════════════════════ 到期与冻结

describe('订阅码 · 到期', () => {
  const expireNow = async (): Promise<void> => {
    await withTenant(tenant, (tx) => tx`
      update billing_accounts set license_period_end = now() - interval '1 hour'
      where location_id = ${SPA_LOC}`);
  };

  it('扫描把到期的店置为 expired（写冻结，读照常），兑一张新码就回来了', async () => {
    const { code } = await issue({
      kind: 'subscription', plan: 'essential', durationDays: 1, paymentNote: 'short',
    });
    await redeem(code);
    await expireNow();

    const log = { info: () => {}, warn: () => {}, error: () => {} };
    const swept = await runLicenseSweep({ log } as never);
    expect(swept.expired).toBeGreaterThanOrEqual(1);
    expect((await acct()).subscription_status).toBe('expired');

    // ① 非 billing 的写操作被冻结
    await expect(dispatch('staff.setLocale', { locale: 'en' }, ctx))
      .rejects.toMatchObject({ code: 'SUBSCRIPTION_PAST_DUE' });

    // ② 读照常
    const view = await withTenant(tenant, (tx) => loadBilling(tx, ctx));
    expect(view!.subscriptionStatus).toBe('expired');
    expect(view!.billingSource).toBe('license');

    // ③ ⭐ 兑换本身仍然可用 —— 欠费时唯一还该能做的写操作就是解决欠费
    const rescue = await issue({
      kind: 'subscription', plan: 'essential', durationDays: 30, paymentNote: 'rescue',
    });
    await redeem(rescue.code);
    const back = await acct();
    expect(back.subscription_status).toBe('active');
    expect(daysFromNow(back.license_period_end)).toBeGreaterThan(29.9);
  });

  it('到期前 7 天入队一封提醒，且只入队一次', async () => {
    const { code } = await issue({
      kind: 'subscription', plan: 'essential', durationDays: 7, paymentNote: 'reminder',
    });
    await redeem(code);

    const log = { info: () => {}, warn: () => {}, error: () => {} };
    const first = await runLicenseSweep({ log } as never);
    expect(first.remindersQueued).toBe(1);

    const [mail] = await withTenant(tenant, (tx) => tx<{ kind: string; subject: string }[]>`
      select kind, subject from email_outbox
      where location_id = ${SPA_LOC} and kind = 'license_expiring'`);
    expect(mail?.kind).toBe('license_expiring');

    // 第二轮不再发（占位列已经写上了）
    const second = await runLicenseSweep({ log } as never);
    expect(second.remindersQueued).toBe(0);
  });

  it('套餐内额度按 30 天边界滚动清零，起点按整段推进（不设成 now）', async () => {
    const { code } = await issue({
      kind: 'subscription', plan: 'growth', durationDays: 365, paymentNote: 'rolling',
    });
    await redeem(code);
    await withTenant(tenant, (tx) => tx`
      update billing_accounts set
        included_credits_used = 42,
        included_period_start = now() - interval '31 days'
      where location_id = ${SPA_LOC}`);

    const log = { info: () => {}, warn: () => {}, error: () => {} };
    const swept = await runLicenseSweep({ log } as never);
    expect(swept.includedRolled).toBe(1);

    const [row] = await withTenant(tenant, (tx) => tx<{ used: number; ago: number }[]>`
      select included_credits_used as used,
             extract(epoch from (now() - included_period_start)) / 86400 as ago
      from billing_accounts where location_id = ${SPA_LOC}`);
    expect(row!.used).toBe(0);
    // 31 天 − 一整段 30 天 = 还剩 1 天，而不是 0（起点不是 now）
    expect(Number(row!.ago)).toBeGreaterThan(0.9);
    expect(Number(row!.ago)).toBeLessThan(1.1);
  });
});

// ══════════════════════════════════════════════════════════ 运营台动作

describe('运营台 · 签发权限与改期', () => {
  it('support 角色签不了码（签发 = 直接放行付费服务）', async () => {
    asSupport();
    const r = await app.inject({
      method: 'POST', url: '/v1/platform/licenses',
      payload: {
        kind: 'subscription', plan: 'growth', durationDays: 30, paymentNote: 'support tries',
      },
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().details.reason).toBe('requires_super_admin');
  });

  it('support 角色仍然看得到列表（能看不能发）', async () => {
    asSupport();
    const r = await app.inject({ method: 'GET', url: '/v1/platform/licenses' });
    expect(r.statusCode).toBe(200);
  });

  it('直接给一家店挂上额度：走的是同一条签发 + 兑换的路', async () => {
    asOps();
    const r = await app.inject({
      method: 'POST', url: `/v1/platform/stores/${SPA_LOC}/license/apply`,
      headers: { 'idempotency-key': randomUUID() },
      payload: {
        kind: 'subscription', plan: 'growth', durationDays: 60,
        paymentNote: 'zelle 2026-09-09 $1200', amountCents: 120000,
      },
    });
    expect(r.statusCode).toBe(200);
    const a = await acct();
    expect(a.billing_source).toBe('license');
    expect(daysFromNow(a.license_period_end)).toBeGreaterThan(59.9);
    expect(a.license_code_id).toBeTruthy();

    // 兑换历史里能查到「为什么是这个到期日」
    const panel = await app.inject({
      method: 'GET', url: `/v1/platform/stores/${SPA_LOC}/license`,
    });
    const body = panel.json() as { history: Array<Record<string, unknown>> };
    expect(body.history.length).toBeGreaterThanOrEqual(1);
    expect(body.history[0]!['paymentNote']).toBe('zelle 2026-09-09 $1200');
  });

  it('改有效期：延 30 天，审计里留下原因', async () => {
    asOps();
    await app.inject({
      method: 'POST', url: `/v1/platform/stores/${SPA_LOC}/license/apply`,
      headers: { 'idempotency-key': randomUUID() },
      payload: {
        kind: 'subscription', plan: 'essential', durationDays: 10, paymentNote: 'base',
      },
    });
    const r = await app.inject({
      method: 'PATCH', url: `/v1/platform/stores/${SPA_LOC}/license`,
      headers: { 'idempotency-key': randomUUID() },
      payload: { extendDays: 30, note: '客户补转了一笔' },
    });
    expect(r.statusCode).toBe(200);
    expect(daysFromNow((await acct()).license_period_end)).toBeGreaterThan(39.9);

    const [audit] = await withTenant(tenant, (tx) => tx<{ after: { note: string } }[]>`
      select after from audit_log
      where location_id = ${SPA_LOC} and command = 'platform.updateLicensePeriod'
      order by at desc limit 1`);
    expect(audit!.after.note).toBe('客户补转了一笔');
  });

  it('改期缺 note 直接 400 —— 没有原因的改期和误操作长得一样', async () => {
    asOps();
    const r = await app.inject({
      method: 'PATCH', url: `/v1/platform/stores/${SPA_LOC}/license`,
      headers: { 'idempotency-key': randomUUID() },
      payload: { extendDays: 30 },
    });
    expect(r.statusCode).toBe(400);
  });

  it('periodEnd 与 extendDays 只能给一个', async () => {
    asOps();
    const r = await app.inject({
      method: 'PATCH', url: `/v1/platform/stores/${SPA_LOC}/license`,
      headers: { 'idempotency-key': randomUUID() },
      payload: { extendDays: 30, periodEnd: new Date().toISOString(), note: 'both' },
    });
    expect(r.statusCode).toBe(400);
  });

  it('立刻收回：当场到期、写冻结，但兑换历史一行不动', async () => {
    asOps();
    await app.inject({
      method: 'POST', url: `/v1/platform/stores/${SPA_LOC}/license/apply`,
      headers: { 'idempotency-key': randomUUID() },
      payload: {
        kind: 'subscription', plan: 'growth', durationDays: 90, paymentNote: 'to be revoked',
      },
    });
    const before = await app.inject({
      method: 'GET', url: `/v1/platform/stores/${SPA_LOC}/license`,
    });
    const beforeCount = (before.json() as { history: unknown[] }).history.length;

    const r = await app.inject({
      method: 'POST', url: `/v1/platform/stores/${SPA_LOC}/license/revoke`,
      payload: { reason: '退款处理' },
    });
    expect(r.statusCode).toBe(200);
    expect((await acct()).subscription_status).toBe('expired');

    const after = await app.inject({
      method: 'GET', url: `/v1/platform/stores/${SPA_LOC}/license`,
    });
    expect((after.json() as { history: unknown[] }).history.length).toBe(beforeCount);
  });
});

// ══════════════════════════════════════════════════════════ 运营直接开店

describe('运营台 · 直接开店（不经 Stripe）', () => {
  /**
   * ⚠️ 店名 + 邮箱每次跑都换一份。
   *
   * 出生幂等键是由这两个字段算出来的（`storeCommands.ts` 的 `provisionKey`），
   * 而运营代开的店**不在种子的两个 org 里，永远不会被清掉**
   * （同 `signup.test.ts` 那家自测店）。写死店名的话，第二次跑这个文件
   * 第一次调用就返回 `already: true` —— 测试红了，而代码是对的。
   */
  const stamp = Date.now().toString(36);
  const NEW_SHOP = {
    shopName: `Ops Opened Spa ${stamp}`,
    ownerEmail: `ops-opened-${stamp}@maildrop.cc`,
  };

  it('建店 + 挂上订阅码，重复提交返回同一家店且不再送天数', async () => {
    asOps();
    const payload = {
      ...NEW_SHOP, plan: 'growth', durationDays: 180,
      paymentNote: 'wechat 2026-09-09 ¥9000', amountCents: 900000,
      sendActivation: false,   // 测试里不发真信
    };
    const first = await app.inject({
      method: 'POST', url: '/v1/platform/stores', payload,
    });
    expect(first.statusCode).toBe(200);
    const created = first.json() as {
      orgId: string; locationId: string; already: boolean; periodEnd: string | null;
    };
    expect(created.already).toBe(false);
    expect(created.locationId).toBeTruthy();

    const [row] = await withTenant(
      { orgId: created.orgId, locationId: created.locationId, membershipId: null },
      (tx) => tx<{ src: string; status: string; plan: string; days: number }[]>`
        select billing_source as src, subscription_status as status, plan,
               extract(epoch from (license_period_end - now())) / 86400 as days
        from billing_accounts where location_id = ${created.locationId}`);
    expect(row!.src).toBe('license');
    expect(row!.status).toBe('active');
    expect(row!.plan).toBe('growth');
    expect(Number(row!.days)).toBeGreaterThan(179.9);

    // ⭐ 双击「开店」不能变成两家店，也不能白送一倍天数
    const second = await app.inject({
      method: 'POST', url: '/v1/platform/stores', payload,
    });
    const again = second.json() as { locationId: string; already: boolean };
    expect(again.already).toBe(true);
    expect(again.locationId).toBe(created.locationId);

    const [after] = await withTenant(
      { orgId: created.orgId, locationId: created.locationId, membershipId: null },
      (tx) => tx<{ days: number }[]>`
        select extract(epoch from (license_period_end - now())) / 86400 as days
        from billing_accounts where location_id = ${created.locationId}`);
    expect(Number(after!.days)).toBeLessThan(180.1);
  });

  it('support 角色开不了店', async () => {
    asSupport();
    const r = await app.inject({
      method: 'POST', url: '/v1/platform/stores',
      payload: {
        shopName: 'Nope', ownerEmail: 'nope@maildrop.cc', plan: 'essential',
        durationDays: 30, paymentNote: 'support tries', sendActivation: false,
      },
    });
    expect(r.statusCode).toBe(403);
  });
});

describe('#27 platform intent retries', () => {
  beforeEach(async () => { asOps(); await resetAccount(); });
  it('serializes concurrent quota grants, replays a lost response, and permits a new grant', async () => {
    const key = randomUUID();
    const request = {
      method: 'POST' as const, url: `/v1/platform/stores/${SPA_LOC}/license/apply`,
      headers: { 'idempotency-key': key },
      payload: { kind: 'quota_pack', unit: 'credit', amount: 500, paymentNote: 'retry regression' },
    };
    const [a, b] = await Promise.all([app.inject(request), app.inject(request)]);
    expect(a.statusCode).toBe(200); expect(b.statusCode).toBe(200);
    expect(a.json()).toEqual(b.json());
    const retry = await app.inject(request);
    expect(retry.json()).toEqual(a.json());
    const next = await app.inject({ ...request, headers: { 'idempotency-key': randomUUID() } });
    expect(next.statusCode).toBe(200);
    expect(next.json().codeId).not.toBe(a.json().codeId);
    const mismatch = await app.inject({ ...request, payload: { ...request.payload, amount: 600 } });
    expect(mismatch.statusCode).toBe(409);
  });
  it('applies subscription renewal and day extension once per operation', async () => {
    const request = {
      method: 'POST' as const, url: `/v1/platform/stores/${SPA_LOC}/license/apply`,
      headers: { 'idempotency-key': randomUUID() },
      payload: { kind: 'subscription', plan: 'essential', durationDays: 30, paymentNote: 'retry regression' },
    };
    expect((await app.inject(request)).statusCode).toBe(200);
    const end = (await acct()).license_period_end;
    expect((await app.inject(request)).statusCode).toBe(200);
    expect((await acct()).license_period_end).toBe(end);
    const extension = {
      method: 'PATCH' as const, url: `/v1/platform/stores/${SPA_LOC}/license`,
      headers: { 'idempotency-key': randomUUID() }, payload: { extendDays: 30, note: 'retry regression' },
    };
    const results = await Promise.all([app.inject(extension), app.inject(extension)]);
    expect(results.map(r => r.statusCode)).toEqual([200, 200]);
    expect(results[0]!.json()).toEqual(results[1]!.json());
    expect(new Date((await acct()).license_period_end!).getTime() - new Date(end!).getTime()).toBe(30 * 86400000);
  });
});
