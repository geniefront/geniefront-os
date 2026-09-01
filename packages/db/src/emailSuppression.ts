/**
 * 邮件抑制名单（sql/0091）。
 *
 * 与 `sms.ts` 的退订查询是同一个位置、同一条纪律：**发出去之前必须再判
 * 一次**。入队的那一刻这个地址可能还是好的，而两者之间隔着几秒到几分钟。
 *
 * ⚠️ 平台级，不按 org 隔离。退信与投诉是收件人与**我们这个发信域名**
 * 之间的事实，不是与某一家门店之间的（理由见 0091 文件头）。
 */

import { sql } from './client';

export type EmailSuppressionReason = 'hard_bounce' | 'complaint' | 'manual';

/** 地址一律小写比对。大小写不同的同一个邮箱是同一个收件人。 */
const norm = (email: string): string => email.trim().toLowerCase();

export async function emailSuppressed(email: string): Promise<boolean> {
  const rows = await sql<{ email: string }[]>`
    select email from email_suppressions where email = ${norm(email)}`;
  return rows.length > 0;
}

/**
 * 批量版 —— flush 一次要判一批，一条一条查是白扔往返
 * （与 `smsOptedOutSet` 同一个理由）。
 *
 * 返回的是**规范化之后**的地址集合，调用方比对时也要规范化。
 */
export async function emailSuppressedSet(
  emails: readonly string[],
): Promise<Set<string>> {
  const list = [...new Set(emails.map(norm).filter((e) => e.length > 0))];
  if (list.length === 0) return new Set();
  const rows = await sql<{ email: string }[]>`
    select email from email_suppressions where email = any(${list})`;
  return new Set(rows.map((r) => r.email));
}

export const normalizeSuppressionEmail = norm;

/**
 * 记一次抑制。同一个地址反复退信是常事 —— upsert，不报错。
 *
 * ⚠️ `reason` 只在**升级**时覆盖：`hard_bounce` 之后又收到 `complaint`
 * 要记成投诉（那是更强的信号，且要连带关掉营销订阅）；反过来不覆盖。
 */
export async function suppressEmail(args: {
  email: string;
  reason: EmailSuppressionReason;
  providerId?: string | null;
  detail?: string | null;
}): Promise<void> {
  const email = norm(args.email);
  if (!email) return;
  await sql`
    insert into email_suppressions (email, reason, provider_id, detail)
    values (${email}, ${args.reason}, ${args.providerId ?? null},
            ${args.detail?.slice(0, 500) ?? null})
    on conflict (email) do update set
      reason = case when excluded.reason = 'complaint'
                    then excluded.reason else email_suppressions.reason end,
      provider_id = excluded.provider_id,
      detail = excluded.detail,
      updated_at = now()`;
}

/**
 * 把某一封信的下场写回发件箱。
 *
 * ⚠️ 按 `provider_id` 定位，跨租户 —— 而 `email_outbox` 是有 RLS 的。
 * 因此走 SECURITY DEFINER 函数：webhook 背后没有租户上下文，它只有
 * 供应商给的一个邮件 id（与 `gf_billing_tenant_for_stripe_refs` 同一个套路）。
 */
export async function recordEmailDelivery(args: {
  providerId: string;
  state: 'delivered' | 'delayed' | 'soft_bounce' | 'hard_bounce' | 'complained';
}): Promise<boolean> {
  const rows = await sql<{ updated: boolean }[]>`
    select gf_record_email_delivery(${args.providerId}, ${args.state}) as updated`;
  return rows[0]?.updated ?? false;
}

/**
 * 收到投诉时，把这个地址的营销订阅一并关掉。
 *
 * ⚠️ 只关**营销**，不动事务性。顾客点「举报垃圾邮件」表达的是不想再收
 * 推广，而他下次自己下单时仍然需要那封确认信 —— 何况抑制名单已经拦住
 * 了一切发往该地址的邮件，这一步管的是「日后他解除抑制之后」。
 */
export async function optOutMarketingByEmail(email: string): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    select gf_marketing_opt_out_by_email(${norm(email)}) as n`;
  return rows[0]?.n ?? 0;
}
