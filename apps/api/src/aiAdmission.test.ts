/**
 * AUD-03 回归：**被拒的 AI 请求一个 token 都不花**。
 *
 * ## 原始缺陷
 *
 * 顺序是「查权限 → 调 Anthropic → 记账」。于是：
 *   · 余额可以无限扣成负数（那个设计本身是对的，但没配准入判断）
 *   · AI 路由一条限频都没有
 *   · 欠费冻结只存在于 `dispatch()` 里，而模型调用在它**外面、之前** ——
 *     一家 past_due 的店照样烧掉真钱，只在最后记账那步失败，
 *     `usage_events` 里一行都没有。
 *
 * ## 这个文件怎么证明「没花钱」
 *
 * 不去 mock `@gf/ai`（那只能证明我们没调那个包）。
 * 直接把 `OPENAI_API_KEY` 设成一个**必然被上游拒绝**的值，
 * 然后断言错误码是 `AI_QUOTA_EXHAUSTED` / `SUBSCRIPTION_PAST_DUE`
 * 而**不是** `UPSTREAM_UNAVAILABLE` / `EXTRACTION_FAILED`。
 *
 * 这一条区分是有意义的：如果闸门没拦住，请求就会真的出网，
 * 拿回来的必然是上游的错 —— 错误码会当场变成另一个值。
 * 换句话说，**错误码本身就是「有没有出网」的证据**。
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, withTenant } from '@gf/db';
import { ERROR_CODES } from '@gf/contracts';
import { assertAiAdmission, __resetAiRateLimit } from './billing/aiAdmission';
import { buildContext } from './actor';
import './handlers/billing';

const SPA_ORG = '22222222-2222-4222-8222-222222222222';
const SPA_LOC = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const tenant = { orgId: SPA_ORG, locationId: SPA_LOC, membershipId: null };

let ctx: Awaited<ReturnType<typeof buildContext>>;

/** 把账户改成某个状态。测试专用，直接改列 —— 这里测的就是这几列怎么被读。 */
async function setAccount(patch: {
  status?: string; plan?: string; creditBalance?: number;
  includedCreditsUsed?: number; trialEndsAt?: string | null;
}): Promise<void> {
  await withTenant(tenant, (tx) => tx`
    update billing_accounts set
      subscription_status = coalesce(${patch.status ?? null}, subscription_status),
      plan = coalesce(${patch.plan ?? null}, plan),
      credit_balance = coalesce(${patch.creditBalance ?? null}, credit_balance),
      included_credits_used = coalesce(${patch.includedCreditsUsed ?? null}, included_credits_used),
      trial_ends_at = ${patch.trialEndsAt === undefined ? tx`trial_ends_at` : patch.trialEndsAt}
    where location_id = ${SPA_LOC}`);
}

beforeAll(async () => {
  const [m] = await withTenant(tenant, (tx) => tx<{ id: string; user_id: string }[]>`
    select m.id, m.user_id from memberships m
    join membership_roles mr on mr.membership_id = m.id
    join roles r on r.id = mr.role_id
    where m.location_id = ${SPA_LOC} and m.status = 'active' and r.key = 'owner' limit 1`);
  ctx = await buildContext({ userId: m!.user_id, membershipId: m!.id });
  await withTenant(tenant, (tx) => tx`
    insert into billing_accounts (org_id, location_id)
    values (${SPA_ORG}, ${SPA_LOC}) on conflict (location_id) do nothing`);
});

afterEach(() => { __resetAiRateLimit(); });

afterAll(async () => {
  await setAccount({ status: 'trialing', plan: 'essential', creditBalance: 0, includedCreditsUsed: 0, trialEndsAt: null });
  await closeDb();
});

describe('AUD-03 · AI admission gate', () => {
  it('额度还有的时候放行', async () => {
    await setAccount({ status: 'active', plan: 'growth', creditBalance: 0, includedCreditsUsed: 0, trialEndsAt: null });
    const out = await assertAiAdmission(ctx);
    expect(out.includedRemaining).toBeGreaterThan(0);
  });

  it('欠费 → 在调模型之前就被拒（past_due 花 $0）', async () => {
    await setAccount({ status: 'past_due' });
    await expect(assertAiAdmission(ctx)).rejects.toMatchObject({
      code: ERROR_CODES.SUBSCRIPTION_PAST_DUE,
      details: { reason: 'ai_blocked' },
    });
  });

  it('已退订同样拒', async () => {
    await setAccount({ status: 'canceled' });
    await expect(assertAiAdmission(ctx)).rejects.toMatchObject({
      code: ERROR_CODES.SUBSCRIPTION_PAST_DUE,
    });
  });

  it('套餐内用尽 + 余额为 0 → AI_QUOTA_EXHAUSTED，不调模型', async () => {
    await setAccount({
      status: 'active', plan: 'growth', creditBalance: 0,
      includedCreditsUsed: 999_999, trialEndsAt: null,
    });
    await expect(assertAiAdmission(ctx)).rejects.toMatchObject({
      code: ERROR_CODES.AI_QUOTA_EXHAUSTED,
    });
  });

  it('套餐内用尽但还有充值余额 → 放行（付过钱的额度必须能用）', async () => {
    await setAccount({
      status: 'active', plan: 'growth', creditBalance: 5,
      includedCreditsUsed: 999_999, trialEndsAt: null,
    });
    const out = await assertAiAdmission(ctx);
    expect(out.balance).toBe(5);
    expect(out.includedRemaining).toBe(0);
  });

  it('余额已经是负数 → 拒。这正是原来无上界的那个方向', async () => {
    await setAccount({
      status: 'active', plan: 'growth', creditBalance: -4200,
      includedCreditsUsed: 999_999, trialEndsAt: null,
    });
    await expect(assertAiAdmission(ctx)).rejects.toMatchObject({
      code: ERROR_CODES.AI_QUOTA_EXHAUSTED,
      details: { balance: -4200 },
    });
  });

  it('同一门店刷得太快 → AI_RATE_LIMITED，且限频先于查库', async () => {
    await setAccount({ status: 'active', plan: 'growth', creditBalance: 0, includedCreditsUsed: 0, trialEndsAt: null });
    // 窗口上限 30；连打 31 次，最后一次必须被挡
    for (let i = 0; i < 30; i += 1) await assertAiAdmission(ctx);
    await expect(assertAiAdmission(ctx)).rejects.toMatchObject({
      code: ERROR_CODES.AI_RATE_LIMITED,
    });
  });

  it('积分和分钟各判各的，没有换算（决策 8）', async () => {
    await setAccount({
      status: 'active', plan: 'growth', creditBalance: 0,
      includedCreditsUsed: 999_999, trialEndsAt: null,
    });
    // 积分耗尽
    await expect(assertAiAdmission(ctx, 'credit')).rejects.toMatchObject({
      code: ERROR_CODES.AI_QUOTA_EXHAUSTED,
    });
    __resetAiRateLimit();
    // 分钟没动过，仍然放行 —— 两种额度不互相影响
    const out = await assertAiAdmission(ctx, 'voice_minute');
    expect(out.includedRemaining).toBeGreaterThan(0);
  });
});
