import type postgres from 'postgres';
/**
 * 技师上机会话：技师怎么在自己手机上证明「我是店里的谁」（sql/0031）
 *
 * ## 为什么不是 Supabase 账号
 *
 * 老板加员工时建的是一条**没有账号的身份**（Ghost Profile）——
 * 那一刻技师本人多半不在场，也未必有邮箱。要求「先注册才能排班」
 * 等于把开店卡在一件和开店无关的事上。
 *
 * ## 为什么不是我们自签的 JWT
 *
 * 因为**手机会丢**。JWT 要么等它过期，要么再造一张吊销名单 ——
 * 而那张名单本身又是一处会忘记同步的状态（宪法第 10 条）。
 * 会话做成一行数据，撤销就是一次 update，立刻生效。
 *
 * 令牌本身沿用设备令牌那套纪律（kiosk/deviceAuth.ts）：
 * **库里只存 SHA-256 摘要，明文只在签发那一刻给一次。**
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  AppError, ERROR_CODES, isPermission,
  type CommandContext, type Locale, type Permission,
} from '@gf/contracts';
import { withStaffToken, withTenant, type StaffSessionRow } from '@gf/db';

export const STAFF_TOKEN_HEADER = 'x-staff-token';

/** 令牌长这样：`gfs_` + 32 字节随机的 base64url。前缀是为了在日志里一眼认出来 */
export function generateStaffToken(): string {
  return `gfs_${randomBytes(32).toString('base64url')}`;
}

export function hashStaffToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** 60 天滚动。技师天天用，过期只发生在「这个人已经不来了」的时候 */
export const STAFF_SESSION_DAYS = 60;

export interface IssuedSession {
  token: string;
  expiresAt: string;
}

/**
 * 签发一条会话。
 *
 * ⚠️ 调用方**必须**先完成验证（上机码或短信验证码）——
 * 这个函数不验证任何东西，它只负责发钥匙。
 */
export async function issueStaffSession(
  t: { orgId: string; locationId: string; membershipId: string },
  method: 'claim_code' | 'phone_otp',
  deviceLabel: string | null,
  transaction?: postgres.TransactionSql,
): Promise<IssuedSession> {
  const token = generateStaffToken();
  const expiresAt = new Date(Date.now() + STAFF_SESSION_DAYS * 24 * 3600_000);

  const save = (tx: postgres.TransactionSql) => tx`
    insert into staff_sessions
      (org_id, location_id, membership_id, token_hash, method, device_label, expires_at)
    values (${t.orgId}, ${t.locationId}, ${t.membershipId},
            ${hashStaffToken(token)}, ${method}, ${deviceLabel},
            ${expiresAt.toISOString()}::timestamptz)`;
  if (transaction) await save(transaction);
  else await withTenant({ ...t, membershipId: null }, save);

  return { token, expiresAt: expiresAt.toISOString() };
}

function unauthenticated(): AppError {
  // 不区分「没这条会话」「过期了」「被踢下线了」—— 对客户端来说
  // 三者要做的事一模一样：重新上机。区分开只是给猜令牌的人多一点信息
  return new AppError(ERROR_CODES.UNAUTHENTICATED, { details: { reason: 'staff_session' } });
}

/**
 * 令牌 → 命令上下文。
 *
 * 权限从 `role_permissions` 实时读，**和 buildContext 完全同源** ——
 * 同一个人用邮箱登录还是用手机上机，拿到的权限一模一样。
 * 换句话说这条路**不放宽任何东西**，它只是换了一种证明「我是谁」的方式。
 *
 * ⚠️ 「技师只看得到自己的单」这条（决策 16）现在仍然由**路由层**把关
 * （`/v1/staff/me/today` 只接受自己的 membershipId）加上手机号服务端脱敏。
 * `app.role_scope = 'staff_self'` 那组叠加策略是留好的第二道，但它要
 * CommandContext 一路带到每一处 withTenant 才生效 —— 那是一次独立的改动，
 * 不该混在上机这条链路里顺手做半个（做半个比不做更糟：
 * 有的查询走了叠加策略、有的没走，而两者看起来一模一样）。
 */
export async function staffContextFromToken(
  rawToken: string | undefined,
  ip?: string,
): Promise<CommandContext & { sessionId: string; displayName: unknown }> {
  const token = (rawToken ?? '').trim();
  if (!token.startsWith('gfs_')) throw unauthenticated();

  let row: StaffSessionRow | null;
  try {
    row = await withStaffToken(hashStaffToken(token));
  } catch {
    throw unauthenticated();
  }
  if (!row) throw unauthenticated();

  if (row.revokedAt) throw unauthenticated();
  if (new Date(row.expiresAt) <= new Date()) throw unauthenticated();

  // 离职之后那条会话就该失效。`staff.setEmployment` 会主动撤销，
  // 但直接改库、或者以后多一条改状态的路时，这里是兜底
  if (row.membershipStatus !== 'active') throw unauthenticated();
  if (['suspended', 'closed'].includes(row.locationStatus)) {
    throw new AppError(ERROR_CODES.LOCATION_SUSPENDED, {
      details: { status: row.locationStatus },
    });
  }

  const granted = await withTenant(
    { orgId: row.orgId, locationId: row.locationId, membershipId: row.membershipId },
    async (tx) => {
      const fromRoles = await tx<{ permission: string }[]>`
        select rp.permission from membership_roles mr
        join role_permissions rp on rp.role_id = mr.role_id
        where mr.membership_id = ${row!.membershipId}`;
      const overrides = await tx<{ permission: string; allow: boolean }[]>`
        select permission, allow from permission_overrides
        where membership_id = ${row!.membershipId}`;
      return { fromRoles, overrides };
    });

  const permissions = new Set<Permission>();
  for (const r of granted.fromRoles) if (isPermission(r.permission)) permissions.add(r.permission);
  for (const o of granted.overrides) {
    if (o.allow && isPermission(o.permission)) permissions.add(o.permission);
  }
  // 撤销最后跑一遍：allow=false 永远赢（和 buildContext 同一条纪律）
  for (const o of granted.overrides) {
    if (!o.allow && isPermission(o.permission)) permissions.delete(o.permission);
  }

  return {
    orgId: row.orgId,
    locationId: row.locationId,
    // Ghost staff legitimately have no platform account. When the membership
    // is linked to one, preserve it so user-scoped RLS (sessions/preferences)
    // sees the same identity as email/OAuth login.
    userId: row.userId,
    membershipId: row.membershipId,
    permissions,
    actorKind: 'user',
    locale: (row.locale ?? row.defaultLocale) as Locale,
    timezone: row.timezone,
    ...(ip ? { ip } : {}),
    sessionId: row.sessionId,
    displayName: row.displayName,
  };
}
