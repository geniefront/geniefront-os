/**
 * 从 membership 解析出命令上下文。
 *
 * 多店切换的核心：一个 user 可以在多家店（甚至不同老板的店）有身份，
 * 登录后选店 → 拿到那一家的 membership → 权限从这条 membership 推导。
 * 换店 = 换一条 membership，不是换账号。
 */

import {
  AppError, ERROR_CODES, isPermission, type CommandContext, type Locale, type Permission,
} from '@gf/contracts';
import { withUser, listMembershipsForUser, loadMembershipBase } from '@gf/db';

export type { MembershipRow } from '@gf/db';

/** 登录后的店铺选择器。绕过 RLS 的理由见 packages/db/src/identity.ts */
export const listMemberships = listMembershipsForUser;

export interface BuildContextArgs {
  /** 从已验签的 JWT 里来，不接受客户端自报 */
  userId: string;
  membershipId: string;
  actorKind?: CommandContext['actorKind'];
  ip?: string;
  /** AI 会话：权限收窄为操作人权限的子集，绝不提权（宪法第 6 条） */
  restrictTo?: readonly Permission[];
}

/**
 * 把一条 membership 变成可执行命令的上下文。
 *
 * 权限 = 角色预设 ∪ 个别授予 − 个别撤销。
 * permission_overrides 里 allow=false 的**永远赢** —— 撤销优先于授予，
 * 否则「这个人不许打折」这种约束会被某个角色悄悄绕过。
 */
export async function buildContext(args: BuildContextArgs): Promise<CommandContext> {
  const { userId, membershipId } = args;

  // 按用户维度查：membership 不属于这个人时直接查不到（不是查到再比对）
  const base = await loadMembershipBase(userId, membershipId);

  // 查不到 = 这条 membership 不属于这个人（用户维度 RLS 保证），
  // 或者根本不存在。两者返回同一个错误，防枚举。
  if (!base) {
    throw new AppError(ERROR_CODES.PERMISSION_DENIED, {
      details: { reason: 'membership_not_owned' },
    });
  }
  if (base.status !== 'active') throw new AppError(ERROR_CODES.MEMBERSHIP_INACTIVE);
  if (['suspended', 'closed'].includes(base.locationStatus)) {
    throw new AppError(ERROR_CODES.LOCATION_SUSPENDED, { details: { status: base.locationStatus } });
  }

  // 和 loadMembershipBase 一样走用户维度：0004 迁移把 role_permissions /
  // permission_overrides 也纳入了 identity 策略，所以一个事务就能读完，
  // 不用为了拿权限再开一个租户上下文事务。
  const granted = await withUser(base.userId, async (tx) => {
      const fromRoles = await tx<{ permission: string }[]>`
        select rp.permission from membership_roles mr
        join role_permissions rp on rp.role_id = mr.role_id
        where mr.membership_id = ${membershipId}`;
      const overrides = await tx<{ permission: string; allow: boolean }[]>`
        select permission, allow from permission_overrides
        where membership_id = ${membershipId}`;
    return { fromRoles, overrides };
  });

  const set = new Set<Permission>();
  for (const r of granted.fromRoles) if (isPermission(r.permission)) set.add(r.permission);
  for (const o of granted.overrides) {
    if (!isPermission(o.permission)) continue;
    if (o.allow) set.add(o.permission);
  }
  // 撤销最后跑一遍：allow=false 永远赢
  for (const o of granted.overrides) {
    if (!o.allow && isPermission(o.permission)) set.delete(o.permission);
  }

  // AI 会话的权限只能更小
  if (args.restrictTo) {
    const allowed = new Set(args.restrictTo);
    for (const p of [...set]) if (!allowed.has(p)) set.delete(p);
  }

  return {
    orgId: base.orgId,
    locationId: base.locationId,
    userId: base.userId,
    membershipId,
    permissions: set,
    actorKind: args.actorKind ?? 'user',
    locale: (base.userLocale ?? base.defaultLocale) as Locale,
    timezone: base.timezone,
    ...(args.ip ? { ip: args.ip } : {}),
  };
}
