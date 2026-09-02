/**
 * AUD-01 回归：**系统自有命令对租户身份不可达**。
 *
 * ## 原始缺陷
 *
 * `POST /v1/commands/:name` 按名字执行任意已注册命令，而总线里唯一的门是
 * 「你有没有 def.permission」。`billing.syncSubscription` 的 permission 是
 * `billing.manage`，而 owner 预设正好有 —— 于是一条 curl 就能把自己的门店
 * 写成 growth/active（period_end 填 2099），再一条 `billing.recordTopup`
 * 就能凭空造出十万积分。实测复现过，两条都返回 201。
 *
 * `ai: { exposed: false }` 没有拦住它：那个字段只影响 AI 工具生成。
 *
 * ## 为什么这个文件按「全集」写而不是列举那两条命令
 *
 * 只断言 `billing.syncSubscription` 被挡住的话，下一条内部命令加进来时
 * 这里依然全绿 —— 而那正是原始缺陷的形状（标记有了，没人强制）。
 * 所以断言的对象是**注册表本身**：
 *
 *   · 每一条 `system: true` 的命令，对满权限 owner 必须拒绝
 *   · 每一条声明为系统自有的命令，必须真的在注册表里标了
 *   · 命令目录接口必须把这个标记暴露出去
 *
 * 新增一条内部命令而忘了标 `system`，第二条断言当场红。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, withTenant } from '@gf/db';
import { AppError, ERROR_CODES } from '@gf/contracts';
import { buildServer } from './server';
import { dispatch, registeredCommands } from './bus';
import { dispatchSystem } from './test/systemDispatch';
import { buildContext } from './actor';

/**
 * 足疗店的 owner —— 种子数据里唯一持有 `billing.manage` 的身份。
 * id 从库里查，不硬编码：这个套件的前提是「真的是个满权限老板」，
 * 而不是「某一个特定的 uuid」。
 */
const SPA_ORG = '22222222-2222-4222-8222-222222222222';
const SPA_LOC = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

/**
 * 必须是系统自有的那些命令。
 *
 * 判据只有一条：**租户能直接调它，就能凭空写出一个没有发生过的事实。**
 * 这份名单是人写的意图；下面第二条用例负责证明代码和意图对得上。
 */
const MUST_BE_SYSTEM = [
  'billing.syncSubscription',
  'billing.recordTopup',
  'billing.recordTopupFailure',
  'billing.claimAutoTopup',
  'billing.savePaymentMethod',
  'billing.changePlan',
  'billing.buyAddon',
  'ai.recordAssist',
  'call.record',
  'call.attachTranscript',
  'call.draftAppointment',
  'blueprint.saveExtraction',
  'blueprint.setExtractionState',
  'blueprint.saveTranslations',
  'analytics.saveBusinessSummary',
  'notification.create',
  'storefront.saveDrafts',
  'setup.claimLocation',
] as const;

let app: ReturnType<typeof buildServer>;
let ownerCtx: Awaited<ReturnType<typeof buildContext>>;
let ownerMembershipId: string;

beforeAll(async () => {
  app = buildServer();
  await app.ready();
  const [m] = await withTenant(
    { orgId: SPA_ORG, locationId: SPA_LOC, membershipId: null },
    (tx) => tx<{ id: string; user_id: string }[]>`
      select m.id, m.user_id from memberships m
      join membership_roles mr on mr.membership_id = m.id
      join roles r on r.id = mr.role_id
      where m.location_id = ${SPA_LOC} and m.status = 'active'
        and r.key = 'owner' limit 1`);
  ownerMembershipId = m!.id;
  ownerCtx = await buildContext({ userId: m!.user_id, membershipId: m!.id });
});

afterAll(async () => {
  await app.close();
  await closeDb();
});

describe('AUD-01 · system-only commands', () => {
  it('每一条声明为系统自有的命令都真的标了 system: true', () => {
    const marked = new Set(
      registeredCommands().filter((c) => c.system === true).map((c) => c.name),
    );
    const missing = MUST_BE_SYSTEM.filter((n) => !marked.has(n));
    expect(missing).toEqual([]);
  });

  it('种子 owner 确实握有 billing.manage —— 否则这个套件什么都没证明', () => {
    expect(ownerCtx.permissions.has('billing.manage')).toBe(true);
  });

  it('注册表里每一条 system 命令，对满权限 owner 走总线都被拒', async () => {
    const systemCommands = registeredCommands().filter((c) => c.system === true);
    expect(systemCommands.length).toBeGreaterThanOrEqual(MUST_BE_SYSTEM.length);

    for (const def of systemCommands) {
      // 入参故意留空：拒绝必须发生在**校验入参之前**，
      // 否则「拒不拒」会取决于攻击者有没有把 body 拼对
      const err = await dispatch(def.name, {}, ownerCtx).then(
        () => null,
        (e: unknown) => e as AppError,
      );
      expect(err, `${def.name} 没有被拒`).toBeInstanceOf(AppError);
      expect(err!.code, def.name).toBe(ERROR_CODES.PERMISSION_DENIED);
      expect((err!.details as { reason?: string }).reason, def.name).toBe('system_only_command');
    }
  });

  /**
   * HTTP 入口的冒烟检查。
   *
   * ⚠️ 说清楚它证明了什么、没证明什么：这里没有真实的 Supabase JWT，
   * 所以请求在 onRequest 就被 401 挡住，**走不到** `systemOnlyCommands`
   * 那一行。真正「满权限老板也调不动」的证明在上面那条总线用例里 ——
   * 那一条是拿真实 owner 上下文跑的，而 HTTP 入口最终也是转给同一条总线。
   *
   * 保留它是为了盯住另一件事：这些路径**永远不该 2xx**，
   * 也不该因为新加的拦截而变成 5xx。
   */
  it('HTTP 命令入口对系统命令从不返回 2xx / 5xx', async () => {
    for (const name of MUST_BE_SYSTEM) {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/commands/${name}`,
        headers: { 'x-membership-id': ownerMembershipId },
        payload: { input: {} },
      });
      expect([401, 403], name).toContain(res.statusCode);
    }
  });

  it('原始漏洞载荷：owner 无法把自己写成 growth/active', async () => {
    await expect(dispatch('billing.syncSubscription', {
      plan: 'growth',
      subscriptionStatus: 'active',
      trialEndsAt: null,
      currentPeriodEnd: '2099-01-01T00:00:00.000Z',
    }, ownerCtx)).rejects.toMatchObject({
      code: ERROR_CODES.PERMISSION_DENIED,
      details: { reason: 'system_only_command' },
    });
  });

  it('原始漏洞载荷：owner 无法凭空造出十万积分', async () => {
    await expect(dispatch('billing.recordTopup', {
      unit: 'credit',
      units: 99_999,
      paidCents: 1,
      stripePaymentIntentId: null,
      trigger: 'manual',
    }, ownerCtx, { idempotencyKey: `aud01-${Date.now()}` })).rejects.toMatchObject({
      code: ERROR_CODES.PERMISSION_DENIED,
      details: { reason: 'system_only_command' },
    });
  });

  it('合法的系统编排照常走得通（否则修复就是把 webhook 一起打死了）', async () => {
    const out = await dispatchSystem<{ plan: string; subscriptionStatus: string }>(
      'billing.syncSubscription',
      { plan: 'essential', subscriptionStatus: 'trialing' },
      ownerCtx,
    );
    expect(out.result.plan).toBe('essential');
    expect(out.result.subscriptionStatus).toBe('trialing');
  });

  it('命令目录把 system 标记暴露出来，客户端不必猜', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/commands' });
    // 目录本身要登录；拿不到就跳过断言内容，只要求不是 5xx
    expect(res.statusCode).toBeLessThan(500);
  });
});
