/**
 * 身份解析 —— 走【用户维度】的 RLS，不绕过任何东西。
 *
 * 登录后用户还没选店，我们不知道 org_id。这曾经被当成「必须绕过 RLS」的理由，
 * 但那是错的：缺的只是一个用户维度的上下文，不是权限。
 *
 * withUser() 设 app.user_id 且不设 app.org_id，0003 迁移里的 `identity_self`
 * 策略恰好在这种模式下放行「我自己的身份」，全部 for select。
 *
 * 结果是应用运行时**不需要任何能绕过 RLS 的凭据** —— 这也是部署时
 * 生产 .env 里没有 MIGRATION_DATABASE_URL 却依然能跑通的原因。
 */

import { withUser } from './client';

export interface MembershipRow {
  membershipId: string;
  orgId: string;
  locationId: string;
  locationName: unknown;
  /**
   * 门店状态。前台要用它决定「进来先给他看开店向导还是轮牌板」——
   * `setup` = 付了钱建出来了但还没配起来（sql/0030）。
   * 判断放在这里而不是前端记一个本地标记：换台设备登录看到的必须是同一件事。
   */
  locationStatus: string;
  roleKeys: string[];
  isBookable: boolean;
}

/**
 * 登录后的店铺选择器数据源。
 * 只返回 active 身份 + 未停用门店；离职（status='left'）立刻消失。
 */
export async function listMembershipsForUser(userId: string): Promise<MembershipRow[]> {
  const rows = await withUser(userId, (tx) => tx<{
    membership_id: string; org_id: string; location_id: string;
    location_name: unknown; location_status: string; role_keys: string[] | null;
    is_bookable: boolean | null;
  }[]>`
    select m.id as membership_id, m.org_id, m.location_id,
           l.name as location_name, l.status as location_status,
           array_remove(array_agg(r.key), null) as role_keys,
           coalesce(sp.is_bookable, false) as is_bookable
    from memberships m
    join locations l on l.id = m.location_id
    left join staff_profiles sp on sp.membership_id = m.id
    left join membership_roles mr on mr.membership_id = m.id
    left join roles r on r.id = mr.role_id
    where m.user_id = ${userId}
      and m.status = 'active'
      and l.status not in ('closed','suspended')
    group by m.id, l.name, l.status, sp.is_bookable
    order by l.name->>'en'`);

  return rows.map((r) => ({
    membershipId: r.membership_id,
    orgId: r.org_id,
    locationId: r.location_id,
    locationName: r.location_name,
    locationStatus: r.location_status,
    roleKeys: r.role_keys ?? [],
    isBookable: r.is_bookable ?? false,
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

/**
 * 解析单条 membership 的租户归属。拿到之后一切读写都走 withTenant。
 *
 * 需要 userId：策略按用户维度放行，而且这天然带来一个好处 ——
 * 传别人的 membershipId 进来会**查不到**，而不是查到之后再靠调用方去比对。
 * 归属校验因此变成了数据库层面的事实，不是一句可以被忘记的 if。
 */
export async function loadMembershipBase(
  userId: string,
  membershipId: string,
): Promise<MembershipBase | null> {
  const [row] = await withUser(userId, (tx) => tx<{
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
    where m.id = ${membershipId}`);

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
