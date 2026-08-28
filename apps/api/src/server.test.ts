/**
 * HTTP 层测试。重点是鉴权链条 —— 尤其「客户端自报的 membershipId 必须验归属」，
 * 那是最容易漏、后果最严重的一环。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SignJWT, generateKeyPair, exportJWK } from 'jose';
import { closeDb, withTenant, loadMembershipBase, listMembershipsForUser } from '@gf/db';
import { AppError } from '@gf/contracts';
import { buildContext } from './actor';
import { buildServer } from './server';

const NAIL_ORG = '11111111-1111-4111-8111-111111111111';
const NAIL_LOC = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';

let app: ReturnType<typeof buildServer>;

beforeAll(async () => { app = buildServer(); await app.ready(); });
afterAll(async () => { await app.close(); await closeDb(); });

describe('健康探针', () => {
  it('不要令牌，也不查数据库', async () => {
    const r = await app.inject({ method: 'GET', url: '/health' });
    expect(r.statusCode).toBe(200);
    expect(r.json().ok).toBe(true);
  });
});

describe('认证', () => {
  it('没带令牌 → 401', async () => {
    const r = await app.inject({ method: 'GET', url: '/v1/me/locations' });
    expect(r.statusCode).toBe(401);
    expect(r.json().code).toBe('UNAUTHENTICATED');
  });

  it('乱造的令牌 → 401', async () => {
    const r = await app.inject({
      method: 'GET', url: '/v1/me/locations',
      headers: { authorization: 'Bearer not.a.jwt' },
    });
    expect(r.statusCode).toBe(401);
  });

  it('⭐ 自己签的令牌骗不过 JWKS 验签', async () => {
    // 用自己的 ES256 私钥签一个格式完全正确的 token
    const { privateKey } = await generateKeyPair('ES256');
    const forged = await new SignJWT({ sub: '00000000-0000-4000-8000-000000000000' })
      .setProtectedHeader({ alg: 'ES256', kid: '59ba6da1-d445-4e66-b23a-31c5fe751dfd' })
      .setIssuer(`${process.env.SUPABASE_URL}/auth/v1`)
      .setAudience('authenticated')
      .setExpirationTime('1h')
      .sign(privateKey);
    void exportJWK;

    const r = await app.inject({
      method: 'GET', url: '/v1/me/locations',
      headers: { authorization: `Bearer ${forged}` },
    });
    expect(r.statusCode).toBe(401);
  });
});

describe('命令入口', () => {
  it('未知命令 → 404（且在验令牌之后才判断）', async () => {
    const r = await app.inject({
      method: 'POST', url: '/v1/commands/does.notExist',
      headers: { authorization: 'Bearer bad' },
    });
    // 令牌先挂，说明没有令牌时连命令名都探测不到
    expect(r.statusCode).toBe(401);
  });

  it('命令目录不需要业务权限，但要登录', async () => {
    const r = await app.inject({ method: 'GET', url: '/v1/commands' });
    expect(r.statusCode).toBe(401);
  });
});

describe('membership 归属校验（最关键的一环）', () => {
  it('⭐ 拿一个不属于自己的 membershipId → 拒绝，且不泄露它是否存在', async () => {
    const { assertMembershipBelongsTo } = await import('./auth');
    // 取一个真实存在、但属于别人的 membership
    const [other] = await withTenant(
      { orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: null },
      (tx) => tx<{ membership_id: string }[]>`
        select membership_id from staff_profiles limit 1`);

    const strangerUserId = '00000000-0000-4000-8000-000000000000';
    const err = await assertMembershipBelongsTo(strangerUserId, other!.membership_id)
      .then(() => null, (e: unknown) => e as AppError);

    expect(err).toBeInstanceOf(AppError);
    expect(err!.code).toBe('PERMISSION_DENIED');
    // 报错里不能带 membershipId 或门店信息，否则可以拿它枚举别家店
    expect(JSON.stringify(err!.details)).not.toContain(other!.membership_id);
  });

  it('⭐ 完全不存在的 membershipId → 同样的错误，同样的措辞', async () => {
    const { assertMembershipBelongsTo } = await import('./auth');
    const err = await assertMembershipBelongsTo(
      '00000000-0000-4000-8000-000000000000',
      '11111111-2222-4333-8444-555555555555',
    ).then(() => null, (e: unknown) => e as AppError);

    // 和上一个测试的结果必须一模一样 —— 能分辨就是一个枚举漏洞
    expect(err!.code).toBe('PERMISSION_DENIED');
    expect(err!.details['reason']).toBe('membership_not_owned');
  });
});

describe('身份解析走用户维度 RLS，不绕过', () => {
  it('⭐ 别人的 membership 直接【查不到】—— 归属校验是数据库事实，不是一句 if', async () => {
    const [victim] = await withTenant(
      { orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: null },
      (tx) => tx<{ membership_id: string; user_id: string }[]>`
        select sp.membership_id, m.user_id
        from staff_profiles sp join memberships m on m.id = sp.membership_id
        where m.user_id is not null
        limit 1`);

    // 本人查得到
    const mine = await loadMembershipBase(victim!.user_id, victim!.membership_id);
    expect(mine).not.toBeNull();
    expect(mine!.orgId).toBe(NAIL_ORG);

    // 换个陌生 userId 查同一条 → null。
    // 注意这里【没有】调用 assertMembershipBelongsTo —— 就算那道检查被删了，
    // RLS 依然让它拿不到数据。
    const stranger = await loadMembershipBase(
      '00000000-0000-4000-8000-000000000000', victim!.membership_id);
    expect(stranger).toBeNull();
  });

  it('陌生用户的选店器是空的', async () => {
    const list = await listMembershipsForUser('00000000-0000-4000-8000-000000000000');
    expect(list).toEqual([]);
  });

  it('⭐ 身份解析模式下看不到业务数据 —— 策略只放行「我自己的身份」', async () => {
    const [victim] = await withTenant(
      { orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: null },
      (tx) => tx<{ user_id: string }[]>`select user_id from memberships where user_id is not null limit 1`);

    const { withUser } = await import('@gf/db');
    const rows = await withUser(victim!.user_id, (tx) =>
      tx<{ n: number }[]>`select count(*)::int as n from customers`);
    // 没设 org_id 就查客户表 → 0 行。身份解析不该成为读业务数据的后门。
    expect(rows[0]!.n).toBe(0);
  });
});

/**
 * ⭐ 为什么前端不能拿 `roleKeys` 去点亮按钮（`GET /v1/me/context` 存在的理由）
 *
 * 实际权限 = 角色预设 ∪ 个别授予 − 个别撤销，而**撤销永远赢**。
 * 老板可以只撤掉某一个前台的 `ticket.discount`（她上个月打折打出事了），
 * 这**不改她的角色** —— `roleKeys` 里还是 `front_desk`。
 *
 * 前端要是照着角色表画界面，那个按钮会一直亮着，点下去 403，
 * 而用的人只会觉得系统坏了。
 */
describe('权限 = 角色 ∪ 授予 − 撤销', () => {
  const NAIL = { orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: null };

  /** 拿种子店那位前台 Mia */
  const findMia = async () => {
    const [r] = await withTenant(NAIL, (tx) => tx<{ id: string; user_id: string }[]>`
      select m.id, m.user_id from memberships m
      join staff_profiles sp on sp.membership_id = m.id
      where m.location_id = ${NAIL_LOC} and sp.display_name->>'en' = 'Mia'`);
    return r!;
  };

  it('⭐ 撤销一条权限之后，角色一个字没变，但那条权限没了', async () => {
    const mia = await findMia();
    const before = await buildContext({ userId: mia.user_id, membershipId: mia.id });
    expect(before.permissions.has('ticket.discount')).toBe(true);

    await withTenant(NAIL, (tx) => tx`
      insert into permission_overrides (membership_id, permission, allow)
      values (${mia.id}, 'ticket.discount', false)
      on conflict (membership_id, permission) do update set allow = false`);
    try {
      const after = await buildContext({ userId: mia.user_id, membershipId: mia.id });
      expect(after.permissions.has('ticket.discount')).toBe(false);

      // 而 /v1/me/locations 里她还是 front_desk —— 这正是不能照角色画界面的原因
      const list = await listMembershipsForUser(mia.user_id);
      const row = list.find((m) => m.membershipId === mia.id);
      expect(row!.roleKeys).toContain('front_desk');
    } finally {
      await withTenant(NAIL, (tx) => tx`
        delete from permission_overrides
        where membership_id = ${mia.id} and permission = 'ticket.discount'`);
    }
  });

  it('授予也生效，但同时授予又撤销时**撤销赢**', async () => {
    const mia = await findMia();
    await withTenant(NAIL, (tx) => tx`
      insert into permission_overrides (membership_id, permission, allow)
      values (${mia.id}, 'report.view', true)
      on conflict (membership_id, permission) do update set allow = true`);
    try {
      const granted = await buildContext({ userId: mia.user_id, membershipId: mia.id });
      expect(granted.permissions.has('report.view')).toBe(true);

      await withTenant(NAIL, (tx) => tx`
        update permission_overrides set allow = false
        where membership_id = ${mia.id} and permission = 'report.view'`);
      const revoked = await buildContext({ userId: mia.user_id, membershipId: mia.id });
      expect(revoked.permissions.has('report.view')).toBe(false);
    } finally {
      await withTenant(NAIL, (tx) => tx`
        delete from permission_overrides
        where membership_id = ${mia.id} and permission = 'report.view'`);
    }
  });

  it('一人多角色：权限是并集，不是第一个角色', async () => {
    // 种子里的 Amy 是 manager 兼 tech（一人多角色是一等公民，01 §5.1）
    const [amy] = await withTenant(NAIL, (tx) => tx<{ id: string; user_id: string }[]>`
      select m.id, m.user_id from memberships m
      join staff_profiles sp on sp.membership_id = m.id
      where m.location_id = ${NAIL_LOC} and sp.display_name->>'en' = 'Amy'`);
    const list = await listMembershipsForUser(amy!.user_id);
    const row = list.find((m) => m.membershipId === amy!.id);
    expect(row!.roleKeys.sort()).toEqual(['manager', 'tech']);

    // ⚠️ 前端拿 roleKeys[0] 当「他的角色」会把 Amy 显示成技师或店长（看数组顺序），
    // 而她两者都是。这个数组必须整个渲染
    const ctx = await buildContext({ userId: amy!.user_id, membershipId: amy!.id });
    expect(ctx.permissions.has('settings.manage')).toBe(true);  // 来自 manager
    expect(ctx.permissions.has('timeclock.punch_self')).toBe(true); // tech 也有
  });
});
