/**
 * 技师上机会话的解析 —— 和 device.ts / identity.ts 同一个思路，不绕过 RLS。
 *
 * 技师手机打进来时我们不知道 org_id：能用的只有一个令牌摘要。
 * 和「门口 iPad 只有一个令牌」「登录后还没选店」一样，
 * **缺的是上下文，不是权限**（sql/0031 §4）。
 *
 * `withStaffToken` 设 `app.staff_token_hash` 且不设 org_id，
 * 策略只放行**摘要恰好相等**的那一行。于是：翻不出会话表、
 * 猜不出别人的令牌、也不需要 service_role。
 */

import { sql } from './client';

const HASH_RE = /^[0-9a-f]{64}$/;

export interface StaffSessionRow {
  sessionId: string;
  orgId: string;
  locationId: string;
  membershipId: string;
  /** Null only for a ghost staff identity that has no platform account yet. */
  userId: string | null;
  /** claim_code | phone_otp —— 事后要能回答「这台手机是怎么绑上的」 */
  method: string;
  displayName: unknown;
  /** 这位技师自己的界面语言（没设就回落到门店默认） */
  locale: string | null;
  timezone: string;
  defaultLocale: string;
  locationStatus: string;
  membershipStatus: string;
  revokedAt: Date | string | null;
  expiresAt: Date | string;
}

export async function withStaffToken(tokenHash: string): Promise<StaffSessionRow | null> {
  if (!HASH_RE.test(tokenHash)) {
    throw new Error('withStaffToken: 参数必须是 SHA-256 的十六进制摘要');
  }

  return sql.begin(async (tx) => {
    // 显式清空 org_id：连接是复用的，带进上一个请求的值会让这次查询
    // 变成「在那个租户里找这条会话」—— 找不到还算好的，找到了就是串店
    await tx`select
      set_config('app.staff_token_hash', ${tokenHash}, true),
      set_config('app.org_id',           '',           true),
      set_config('app.location_id',      '',           true),
      set_config('app.user_id',          '',           true),
      set_config('app.membership_id',    '',           true)`;

    const rows = await tx<{
      id: string; org_id: string; location_id: string; membership_id: string;
      user_id: string | null;
      method: string; display_name: unknown; profile_locale: string | null;
      tz: string; default_locale: string; loc_status: string; m_status: string;
      revoked_at: Date | string | null; expires_at: Date | string;
    }[]>`
      select s.id, s.org_id, s.location_id, s.membership_id, m.user_id, s.method,
             sp.display_name, sp.locale as profile_locale,
             l.timezone as tz, o.default_locale, l.status as loc_status,
             m.status as m_status, s.revoked_at, s.expires_at
      from staff_sessions s
      join memberships m on m.id = s.membership_id
      join staff_profiles sp on sp.membership_id = s.membership_id
      join locations l on l.id = s.location_id
      join organizations o on o.id = s.org_id
      where s.token_hash = ${tokenHash}`;

    const r = rows[0];
    if (!r) return null;

    // 老板在员工页看「这台手机还在不在用」，那是决定要不要踢下线的唯一依据
    await tx`update staff_sessions set last_seen_at = now() where id = ${r.id}`;

    return {
      sessionId: r.id,
      orgId: r.org_id,
      locationId: r.location_id,
      membershipId: r.membership_id,
      userId: r.user_id,
      method: r.method,
      displayName: r.display_name,
      locale: r.profile_locale,
      timezone: r.tz,
      defaultLocale: r.default_locale,
      locationStatus: r.loc_status,
      membershipStatus: r.m_status,
      revokedAt: r.revoked_at,
      expiresAt: r.expires_at,
    };
  }) as Promise<StaffSessionRow | null>;
}

export interface StaffMatch {
  membershipId: string;
  orgId: string;
  locationId: string;
  displayName?: unknown;
}

/**
 * 兑换上机码。**查到即作废**（sql/0031 §5 那个函数在同一条 update 里做完）。
 *
 * ⚠️ 6 位码的摘要**不是秘密** —— 一百万种可以离线全跑一遍。
 * 真正的防线是调用方的限频 + 几分钟时效；这里保证的是「猜中一次也只能用一次」。
 */
export async function redeemStaffClaimCode(codeHash: string): Promise<StaffMatch | null> {
  const [row] = await sql<{
    membership_id: string; org_id: string; location_id: string;
  }[]>`select * from gf_redeem_staff_claim_code(${codeHash})`;
  if (!row) return null;
  return { membershipId: row.membership_id, orgId: row.org_id, locationId: row.location_id };
}

/**
 * 已验证的手机号 → 在岗身份。
 *
 * ⚠️ **这个函数不验证任何东西** —— 它是「短信验证通过之后找人」的那一步。
 * 一个技师在两家店上班就返回两条，那是常态：界面让他选一家。
 */
export async function staffByPhone(phoneE164: string): Promise<StaffMatch[]> {
  const rows = await sql<{
    membership_id: string; org_id: string; location_id: string; display_name: unknown;
  }[]>`select * from gf_staff_by_phone(${phoneE164})`;
  return rows.map((r) => ({
    membershipId: r.membership_id, orgId: r.org_id,
    locationId: r.location_id, displayName: r.display_name,
  }));
}
