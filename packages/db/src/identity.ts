/**
 * 身份解析 —— 唯一合法绕过 RLS 的读取路径。
 *
 * 为什么必须绕过：登录后用户还没选店，我们不知道 org_id，
 * 而 RLS 策略读的就是 app.org_id。这是先有鸡还是先有蛋的问题，
 * 无法用租户上下文解决。
 *
 * 所以这里把绕过收敛成**两个具名、窄口径的函数**，而不是给 apps/ 一条
 * 通用的 admin 连接。区别很实在：
 *   - 这两个函数的 SQL 是写死的，永远按 user_id / membership_id 过滤
 *   - 想加新的绕过查询，得改这个文件，review 时看得见
 *   - apps/ 仍然拿不到 adminSql，lint-guards 照常拦
 *
 * 除了这两个函数，任何业务读写都必须走 client.ts 的 withTenant()。
 */

import { adminSql } from './admin';

export interface MembershipRow {
  membershipId: string;
  orgId: string;
  locationId: string;
  locationName: unknown;
  roleKeys: string[];
}

/**
 * 登录后的店铺选择器数据源。
 * 只返回 active 身份 + 未停用门店；离职（status='left'）立刻消失。
 */
export async function listMembershipsForUser(userId: string): Promise<MembershipRow[]> {
  const rows = await adminSql<{
    membership_id: string; org_id: string; location_id: string;
    location_name: unknown; role_keys: string[] | null;
  }[]>`
    select m.id as membership_id, m.org_id, m.location_id,
           l.name as location_name,
           array_remove(array_agg(r.key), null) as role_keys
    from memberships m
    join locations l on l.id = m.location_id
    left join membership_roles mr on mr.membership_id = m.id
    left join roles r on r.id = mr.role_id
    where m.user_id = ${userId}
      and m.status = 'active'
      and l.status not in ('closed','suspended')
    group by m.id, l.name
    order by l.name->>'en'`;

  return rows.map((r) => ({
    membershipId: r.membership_id,
    orgId: r.org_id,
    locationId: r.location_id,
    locationName: r.location_name,
    roleKeys: r.role_keys ?? [],
  }));
}

export interface MembershipBase {
  orgId: string;
  locationId: string;
  userId: string;
  status: string;
  locationStatus: string;
  timezone: string;
  defaultLocale: string;
  userLocale: string | null;
}

/** 解析单条 membership 的租户归属。拿到之后一切读写都走 withTenant。 */
export async function loadMembershipBase(membershipId: string): Promise<MembershipBase | null> {
  const [row] = await adminSql<{
    org_id: string; location_id: string; user_id: string;
    status: string; loc_status: string; timezone: string;
    default_locale: string; user_locale: string | null;
  }[]>`
    select m.org_id, m.location_id, m.user_id, m.status,
           l.status as loc_status, l.timezone,
           o.default_locale, u.locale as user_locale
    from memberships m
    join locations l on l.id = m.location_id
    join organizations o on o.id = m.org_id
    join users u on u.id = m.user_id
    where m.id = ${membershipId}`;

  if (!row) return null;
  return {
    orgId: row.org_id,
    locationId: row.location_id,
    userId: row.user_id,
    status: row.status,
    locationStatus: row.loc_status,
    timezone: row.timezone,
    defaultLocale: row.default_locale,
    userLocale: row.user_locale,
  };
}
