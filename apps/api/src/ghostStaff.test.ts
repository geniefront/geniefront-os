/**
 * 占位符员工（Ghost Profile）与技师上机（sql/0031）。
 *
 * 这一份里最要紧的**不是**「加员工能加成功」，而是那条当初被标成
 * 「风险最大」的东西到底封没封死（docs/12 §6.3）：
 *
 *   `memberships.user_id` 一旦可以为空，「这条 membership 是不是一个真人」
 *   会不会变成每个查询各自判断的事？漏判的表现是「技师看得到别人的单」。
 *
 * 下面第一组就是盯着它的：**ghost 在身份解析里根本不存在**，
 * 不是「查到了再拒绝」。
 *
 * 短信那一条不在这里测 —— 验证码是 Telnyx 生成和校验的，
 * 我们这一侧能验的是「没配 Verify Profile 时整条路是不可用而不是假装发了」。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { withTenant, closeDb, listMembershipsForUser, redeemStaffClaimCode, staffByPhone } from '@gf/db';
import { AppError } from '@gf/contracts';
import { buildContext } from './actor';
import { dispatch } from './bus';
import { claimCodeHash } from './handlers/staff';
import {
  issueStaffSession, staffContextFromToken, hashStaffToken,
} from './auth/staffSession';
import { verifyConfigured, otpProvider } from './auth/phoneOtp';
import './handlers/staff';

/** 美甲店：种子里的店长 Amy 有 staff.manage */
const NAIL_ORG = '11111111-1111-4111-8111-111111111111';
const NAIL_LOC = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const tenant = { orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: null };

/** 一个绝不该属于任何人的手机号（种子里没有） */
const PHONE = '+15125550199';

let ctx: Awaited<ReturnType<typeof buildContext>>;
let ghostId = '';

/** 每次跑之前先把上一次留下的自测员工清掉 */
async function cleanup(): Promise<void> {
  await withTenant(tenant, async (tx) => {
    const rows = await tx<{ membership_id: string }[]>`
      select membership_id from staff_profiles
      where location_id = ${NAIL_LOC}
        and (phone_e164 = ${PHONE} or display_name->>'en' like 'Selftest%')`;
    for (const r of rows) {
      await tx`delete from staff_sessions where membership_id = ${r.membership_id}`;
      await tx`delete from rotation_participants where membership_id = ${r.membership_id}`;
      await tx`delete from membership_roles where membership_id = ${r.membership_id}`;
      await tx`delete from staff_profiles where membership_id = ${r.membership_id}`;
      await tx`delete from memberships where id = ${r.membership_id}`;
    }
  });
}

beforeAll(async () => {
  // Amy：店长兼技师，有 staff.manage
  const list = await withTenant(tenant, (tx) => tx<{ id: string; user_id: string }[]>`
    select m.id, m.user_id from memberships m
    join staff_profiles sp on sp.membership_id = m.id
    where m.location_id = ${NAIL_LOC} and sp.display_name->>'en' = 'Amy'`);
  const amy = list[0]!;
  ctx = await buildContext({ userId: amy.user_id, membershipId: amy.id });

  await cleanup();
  const out = await dispatch<{ membershipId: string }>('staff.add', {
    displayName: 'Selftest Ghost',
    phoneE164: PHONE,
    roleKeys: ['tech'],
    isBookable: true,
    inRotation: true,
  }, ctx);
  ghostId = out.result.membershipId;
});

afterAll(async () => {
  await cleanup();
  await closeDb();
});

describe('Ghost Profile：加进来就能干活，但登不进来', () => {
  it('建出来的是一条没有账号的身份', async () => {
    const [m] = await withTenant(tenant, (tx) => tx<{ user_id: string | null; status: string }[]>`
      select user_id, status from memberships where id = ${ghostId}`);
    expect(m!.user_id).toBeNull();
    // ⭐ 状态是 active —— 他是一位**真实在岗**的技师，只是还没上机。
    // 用一个特殊状态表示「还没上机」的话，所有 `status = 'active'` 的
    // 查询（排期、轮牌、结账）都会把他漏掉，而他明明就在店里
    expect(m!.status).toBe('active');
  });

  it('立刻就能被排单：在可接客的员工列表里', async () => {
    const rows = await withTenant(tenant, (tx) => tx<{ n: string }[]>`
      select display_name->>'en' as n from staff_profiles
      where location_id = ${NAIL_LOC} and is_bookable = true and membership_id = ${ghostId}`);
    expect(rows.length).toBe(1);
  });

  it('⭐ ghost 在身份解析里根本不存在 —— 不是查到了再拒绝', async () => {
    /**
     * 这一条是整份文件的核心。
     *
     * 身份解析只有两个入口，两个都拿 `user_id = app_user_id()` 比对，
     * 而 **NULL 不等于任何东西**。所以：
     *   · 拿任何一个真实用户去列门店，列不出 ghost
     *   · 拿 ghost 的 membershipId 去建上下文，直接 PERMISSION_DENIED
     */
    const [amy] = await withTenant(tenant, (tx) => tx<{ user_id: string }[]>`
      select m.user_id from memberships m
      join staff_profiles sp on sp.membership_id = m.id
      where m.location_id = ${NAIL_LOC} and sp.display_name->>'en' = 'Amy'`);

    const mine = await listMembershipsForUser(amy!.user_id);
    expect(mine.some((m) => m.membershipId === ghostId)).toBe(false);

    // 拿别人的账号 + ghost 的 membership 去冒充他 → 查不到
    await expect(
      buildContext({ userId: amy!.user_id, membershipId: ghostId }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('店内手机号唯一：同一个号码不能是两个人', async () => {
    await expect(dispatch('staff.add', {
      displayName: 'Selftest Dup', phoneE164: PHONE, roleKeys: ['tech'],
    }, ctx)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { reason: 'phone_already_used_in_location' },
    });
  });

  it('⭐ 加不出第二个老板', async () => {
    // contracts 的 enum 就把 owner 挡在外面 —— 一个能加员工的店长
    // 顺手加出第二个老板，是这条命令最坏的用法
    await expect(dispatch('staff.add', {
      displayName: 'Selftest Owner', roleKeys: ['owner'],
    }, ctx)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('上机码：老板念给他的那 6 个数字', () => {
  it('发一张码，兑换一次就作废', async () => {
    const issued = await dispatch<{ code: string }>(
      'staff.issueClaimCode', { membershipId: ghostId }, ctx);
    expect(issued.result.code).toMatch(/^\d{6}$/);

    const first = await redeemStaffClaimCode(claimCodeHash(issued.result.code));
    expect(first?.membershipId).toBe(ghostId);

    // ⭐ 一次性：第二次拿同一个码什么都换不到。
    // 「查到即作废」在同一条 update 里做完，中间没有可以插进来的缝隙
    expect(await redeemStaffClaimCode(claimCodeHash(issued.result.code))).toBeNull();
  });

  it('过期的码换不到东西', async () => {
    const issued = await dispatch<{ code: string }>(
      'staff.issueClaimCode', { membershipId: ghostId }, ctx);
    await withTenant(tenant, (tx) => tx`
      update staff_profiles set claim_code_expires_at = now() - interval '1 minute'
      where membership_id = ${ghostId}`);
    expect(await redeemStaffClaimCode(claimCodeHash(issued.result.code))).toBeNull();
  });

  it('乱猜一个码换不到东西', async () => {
    expect(await redeemStaffClaimCode(claimCodeHash('000000'))).toBeNull();
  });
});

describe('上机会话：能用、能踢下线', () => {
  it('会话令牌解出来的权限，和用邮箱登录的人一模一样', async () => {
    const s = await issueStaffSession(
      { orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: ghostId },
      'claim_code', '自测');

    const staffCtx = await staffContextFromToken(s.token);
    expect(staffCtx.membershipId).toBe(ghostId);
    expect(staffCtx.locationId).toBe(NAIL_LOC);
    // ⭐ 他没有平台账号 —— 「谁做的」由 membership 表示（audit_log.actor_id）
    expect(staffCtx.userId).toBeNull();
    // 技师该有的：看自己的单、开始/完成、打自己的卡
    expect(staffCtx.permissions.has('ticket.write')).toBe(true);
    expect(staffCtx.permissions.has('timeclock.punch_self')).toBe(true);
    // 技师不该有的：看别人的收入、改配置、看账单
    expect(staffCtx.permissions.has('payroll.view_all')).toBe(false);
    expect(staffCtx.permissions.has('settings.manage')).toBe(false);
    expect(staffCtx.permissions.has('billing.manage')).toBe(false);
  });

  it('⭐ 踢下线之后立刻用不了 —— 手机丢了就是靠这个', async () => {
    const s = await issueStaffSession(
      { orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: ghostId },
      'phone_otp', '自测');
    expect((await staffContextFromToken(s.token)).membershipId).toBe(ghostId);

    await dispatch('staff.revokeSessions', { membershipId: ghostId }, ctx);

    await expect(staffContextFromToken(s.token)).rejects.toBeInstanceOf(AppError);
  });

  it('离职会把他手机上的登录一起掐掉', async () => {
    const s = await issueStaffSession(
      { orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: ghostId },
      'claim_code', '自测');
    await dispatch('staff.setEmployment', { membershipId: ghostId, status: 'left' }, ctx);
    await expect(staffContextFromToken(s.token)).rejects.toBeInstanceOf(AppError);

    // 离职的人手里那张上机码也不该还能用
    const issued = await withTenant(tenant, (tx) => tx<{ h: string | null }[]>`
      select claim_code_hash as h from staff_profiles where membership_id = ${ghostId}`);
    expect(issued[0]!.h).toBeNull();

    // 放回在岗，后面的用例还要用
    await dispatch('staff.setEmployment', { membershipId: ghostId, status: 'active' }, ctx);
  });

  it('库里只有摘要，明文令牌存不下来', async () => {
    const s = await issueStaffSession(
      { orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: ghostId },
      'claim_code', '自测');
    const rows = await withTenant(tenant, (tx) => tx<{ token_hash: string }[]>`
      select token_hash from staff_sessions where membership_id = ${ghostId}
      order by created_at desc limit 1`);
    expect(rows[0]!.token_hash).toBe(hashStaffToken(s.token));
    expect(rows[0]!.token_hash).not.toContain(s.token);
  });

  it('乱造的令牌一律 401', async () => {
    await expect(staffContextFromToken('gfs_不存在的令牌')).rejects.toBeInstanceOf(AppError);
    await expect(staffContextFromToken('随便什么')).rejects.toBeInstanceOf(AppError);
    await expect(staffContextFromToken(undefined)).rejects.toBeInstanceOf(AppError);
  });
});

describe('手机号找人', () => {
  it('按号码找得到在岗的那条身份', async () => {
    const found = await staffByPhone(PHONE);
    expect(found.some((f) => f.membershipId === ghostId)).toBe(true);
  });

  it('离职的人按号码找不到 —— 短信验证码也进不来', async () => {
    await dispatch('staff.setEmployment', { membershipId: ghostId, status: 'left' }, ctx);
    const found = await staffByPhone(PHONE);
    expect(found.some((f) => f.membershipId === ghostId)).toBe(false);
    await dispatch('staff.setEmployment', { membershipId: ghostId, status: 'active' }, ctx);
  });

  it('陌生号码什么都找不到', async () => {
    expect(await staffByPhone('+15125550000')).toEqual([]);
  });

  it('用哪家 Verify 由环境变量决定，不由代码决定', () => {
    /**
     * 语音走 Telnyx，**验证码短信走 Twilio**（`09` §5）——
     * 因为 Telnyx 名下的美国 A2P 10DLC 还在排队，而排队期间
     * 长号码发的验证码会被运营商**静默**过滤。
     *
     * 切回 Telnyx 是删一行环境变量的事，不用发版：
     */
    const before = { ...process.env };
    try {
      process.env['TWILIO_ACCOUNT_SID'] = 'AC0';
      process.env['TWILIO_AUTH_TOKEN'] = 't';
      process.env['TWILIO_VERIFY_SERVICE_SID'] = 'VA0';
      process.env['TELNYX_API_KEY'] = 'k';
      process.env['TELNYX_VERIFY_PROFILE_ID'] = 'p';
      expect(otpProvider()).toBe('twilio');

      delete process.env['TWILIO_VERIFY_SERVICE_SID'];
      expect(otpProvider()).toBe('telnyx');

      // ⚠️ 一家都没配时**整条路不可用**，而不是「假装发了」——
      // 后者会让技师在登录页反复点重发，每一次都真的花钱
      delete process.env['TELNYX_VERIFY_PROFILE_ID'];
      expect(otpProvider()).toBeNull();
      expect(verifyConfigured()).toBe(false);
    } finally {
      for (const k of ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_VERIFY_SERVICE_SID',
                       'TELNYX_API_KEY', 'TELNYX_VERIFY_PROFILE_ID']) {
        if (before[k] === undefined) delete process.env[k];
        else process.env[k] = before[k];
      }
    }
  });
});
