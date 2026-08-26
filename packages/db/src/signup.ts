/**
 * 自助开户的两个数据库入口（sql/0030，docs/12）。
 *
 * ## 为什么这两件事不能走 withTenant()
 *
 * withTenant() 的前提是「已经知道自己在哪个租户里」。而这条链路上：
 *   · **建租户**的时候，租户按定义还不存在
 *   · **认领门店**的时候，用户还没有任何 membership
 *
 * 这两个不是权限问题，是**上下文缺失**问题 —— 和 identity.ts 里那一段
 * 是同一类。解法也是同一类：一个极窄的口子，而不是一把万能钥匙。
 *
 * ## 这里没有绕过 RLS
 *
 * 连的仍然是 `app_user`（没有 BYPASSRLS）。它能做的全部事情，就是
 * 调用 sql/0030 里那两个 SECURITY DEFINER 函数 —— 那两个函数
 * 各自只做一件事，而且**判定逻辑在函数里，不在这一侧**：
 *
 *   · gf_provision_tenant()       幂等靠 checkout_session_id，重投不会建出第二家
 *   · gf_signup_intent_for_user() 邮箱比对的是 auth.users 那一行，应用插不上话
 *
 * 应用运行时**依然不需要任何能绕过 RLS 的凭据**（宪法第 5 条）。
 */

import { sql } from './client';

export interface ProvisionTenantArgs {
  /** Stripe 的 checkout session id —— 幂等的全部依据 */
  checkoutSessionId: string;
  shopName: string;
  ownerEmail: string;
  businessType: string;
  timezone: string;
  locale: string;
  plan: string;
  phone?: string | null;
  /** 官网传来的 metadata，原样留档 */
  metadata?: Record<string, unknown>;
}

export interface ProvisionedTenant {
  orgId: string;
  locationId: string;
  /** true = 这个 session 之前就建过了（Stripe 重投）。**不要再发一次激活信** */
  already: boolean;
}

export async function provisionTenant(a: ProvisionTenantArgs): Promise<ProvisionedTenant> {
  const [row] = await sql<{ org_id: string; location_id: string; already: boolean }[]>`
    select * from gf_provision_tenant(
      ${a.checkoutSessionId}, ${a.shopName}, ${a.ownerEmail}, ${a.businessType},
      ${a.timezone}, ${a.locale}, ${a.plan}, ${a.phone ?? null},
      ${JSON.stringify(a.metadata ?? {})}::jsonb)`;
  if (!row) throw new Error('gf_provision_tenant 没有返回行');
  return { orgId: row.org_id, locationId: row.location_id, already: row.already };
}

export interface ClaimableIntent {
  intentId: string;
  orgId: string;
  locationId: string;
  ownerEmail: string;
  plan: string;
  /** 店名。Google 登录之后那一屏要写「你有一家 XX 等着开通」（sql/0047） */
  shopName: string;
}

/**
 * 「这个登录用户可以认领哪一家店」。
 *
 * ⚠️ 传进去的只有 user id，**而它来自已验签的 JWT**。邮箱由函数自己
 * 从 auth.users 取 —— 应用这一侧连报一个邮箱的机会都没有，
 * 于是「谁能成为这家店的老板」是一条数据库事实（docs/12 §3 B2）。
 *
 * 一个邮箱买了两家店就有两行：一次认领一家，认领完再调一次。
 *
 * ⭐ 0047 起比对的是 **`gf_canonical_email`**，不是 `lower()`。
 * 起因是 Google 登录：老板结账时手打 `john.doe@gmail.com`，
 * Google 回来的是规范形式 `johndoe@gmail.com` —— 字符串不等，
 * 于是他付了钱却拿到一句「没有可认领的门店」。
 * ⚠️ 点号规则只对 gmail/googlemail 成立，Workspace 自建域名不去点。
 */
export async function claimableIntentFor(userId: string): Promise<ClaimableIntent | null> {
  const [row] = await sql<{
    intent_id: string; org_id: string; location_id: string;
    owner_email: string; plan: string; shop_name: string | null;
  }[]>`select * from gf_signup_intent_for_user(${userId})`;
  if (!row) return null;
  return {
    intentId: row.intent_id, orgId: row.org_id, locationId: row.location_id,
    ownerEmail: row.owner_email, plan: row.plan,
    shopName: row.shop_name ?? '',
  };
}
