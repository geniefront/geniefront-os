/**
 * 填表链接维度的解析 —— 和 device.ts / publicBooking.ts 同一个思路，不绕过 RLS。
 *
 * 客人点开链接时我们不知道 org_id：能用的只有一个令牌。
 * 和「登录后还没选店」「webhook 只带一个被叫号码」一样，
 * **缺的是上下文，不是权限**。
 *
 * `withFormShareToken` 设 `app.form_token_hash` 且不设 org_id，
 * sql/0038 里的策略只放行**摘要恰好相等**的那一行。
 *
 * ⚠️ 这里解析出来的上下文**只够用来认出「哪家店、哪个人、哪几份表」**。
 * 真正的读题目和交表在认出之后走正常的 withTenant —— 和门口 iPad 一模一样。
 * 别在这里顺手多查点别的：这条路上没有登录用户，多查一样东西就是多一样
 * 能被一条捡来的链接读走的东西。
 */

import { sql } from './client';

/** SHA-256 的十六进制摘要 */
const HASH_RE = /^[0-9a-f]{64}$/;

export interface FormShareRow {
  id: string;
  orgId: string;
  locationId: string;
  customerId: string | null;
  appointmentId: string | null;
  templateIds: string[];
  channel: string;
  locale: string;
  createdAt: Date | string;
  expiresAt: Date | string;
  openedAt: Date | string | null;
  submittedAt: Date | string | null;
  revokedAt: Date | string | null;
  /** 客人那一页要显示是哪家店 —— 一封转发来的邮件必须能自证是谁发的 */
  shopName: Record<string, string>;
  shopPhone: string | null;
  timezone: string;
  defaultLocale: string;
  locationStatus: string;
}

/**
 * 认链接。
 *
 * ⚠️ 认不出、过期了、吊销了、已经填完了 —— **这里一律照原样返回**，
 * 由调用方去判断并给出**同一句**「这个链接不能用了，请联系门店」。
 * 分开报（「过期了」vs「不存在」）对客人没有帮助，对试探的人有。
 */
export async function withFormShareToken(tokenHash: string): Promise<FormShareRow | null> {
  if (!HASH_RE.test(tokenHash)) {
    throw new Error('withFormShareToken: 参数必须是 SHA-256 的十六进制摘要');
  }

  return sql.begin(async (tx) => {
    // 显式清空 org_id：连接是复用的，带进上一个请求的值会让这次查询
    // 变成「在那个租户里找这条链接」—— 找不到还算好的，找到了就是串店
    await tx`select
      set_config('app.form_token_hash',   ${tokenHash}, true),
      set_config('app.org_id',            '',           true),
      set_config('app.location_id',       '',           true),
      set_config('app.user_id',           '',           true),
      set_config('app.device_token_hash', '',           true),
      set_config('app.public_key',        '',           true)`;

    const rows = await tx<{
      id: string; org_id: string; location_id: string;
      customer_id: string | null; appointment_id: string | null;
      template_ids: unknown; channel: string; locale: string;
      created_at: Date | string; expires_at: Date | string;
      opened_at: Date | string | null;
      submitted_at: Date | string | null; revoked_at: Date | string | null;
      shop_name: unknown; shop_phone: string | null; tz: string;
      default_locale: string; loc_status: string;
    }[]>`
      select f.id, f.org_id, f.location_id, f.customer_id, f.appointment_id,
             f.template_ids, f.channel, f.locale, f.created_at, f.expires_at,
             f.opened_at, f.submitted_at, f.revoked_at,
             l.name as shop_name, l.phone as shop_phone, l.timezone as tz,
             l.status as loc_status, o.default_locale
      from form_share_links f
      join locations l on l.id = f.location_id
      join organizations o on o.id = f.org_id
      where f.token_hash = ${tokenHash}`;

    const r = rows[0];
    if (!r) return null;

    // 点开过就记一次。⚠️ 只在第一次记 —— 客人来回刷新会盖掉「他什么时候
    // 第一次看到这张表」，而那正是前台判断「他到底收没收到」要看的数
    if (!r.opened_at) {
      await tx`update form_share_links set opened_at = now() where id = ${r.id}`;
    }

    return {
      id: r.id,
      orgId: r.org_id,
      locationId: r.location_id,
      customerId: r.customer_id,
      appointmentId: r.appointment_id,
      templateIds: Array.isArray(r.template_ids) ? r.template_ids as string[] : [],
      channel: r.channel,
      locale: r.locale,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      openedAt: r.opened_at,
      submittedAt: r.submitted_at,
      revokedAt: r.revoked_at,
      shopName: (r.shop_name ?? {}) as Record<string, string>,
      shopPhone: r.shop_phone,
      timezone: r.tz,
      defaultLocale: r.default_locale,
      locationStatus: r.loc_status,
    };
  }) as Promise<FormShareRow | null>;
}
