/**
 * 客人发进来的短信 —— 给前台看的那一条列表。
 *
 * ## ⭐ 为什么这一页必须存在
 *
 * 运营商强制 **CANCEL** 是退订关键词。而在一个预约系统里，客人打这六个字母
 * 十有八九想的是「取消我的预约」—— 他收到一条「已退订」，**以为事情办完了**，
 * 而店里那一格还占着，周六下午白空一个小时，人也没来。
 *
 * 退订之后我们**再也发不了短信给他**（运营商在网络层就掐了）。
 * 所以这张列表是那一刻唯一剩下的线索：前台看到「这个号 3 点 12 分发过 CANCEL」，
 * 能主动打个电话问一句。
 *
 * ## ⚠️ 这里有一个跨租户的边界，是绕开的不是无视的
 *
 * `sms_inbound` 是**平台级**的表（没有 org_id）。归属在 webhook 落库那一刻
 * 就定死写进行里（`routing_scope` / `resolved_org` / `resolved_location`，
 * sql/0115），读取只认这几列：
 *
 *   · `routing_scope = 'store'` 且 `resolved_org` / `resolved_location` 对得上
 *     本店 —— 命中门店专属线（新客未建档也算），或平台共享号上恰好一家店
 *     与该号有过站内短信会话。
 *   · `platform` / `unresolved` —— 无可靠唯一归属，对**所有**租户不可见
 *     （按用户给出的降级许可，计划 §3.2.5）。
 *
 * RLS（`inbound_select_own`，sql/0115）已按同一条件收窄 SELECT；这里的显式
 * 过滤是纵深防御的第二道。号码换绑后归属不变 —— 读取不再查 `phone_lines`。
 */

import type postgres from 'postgres';
import type { CommandContext } from '@gf/contracts';

export interface InboundSms {
  id: string;
  fromE164: string;
  body: string;
  intent: string;
  receivedAt: string;
  /** 本店客户里号码对得上的那些。同号多客户是常态，所以是数组（宪法第 16 条） */
  customers: Array<{ id: string; name: string }>;
  /** ⭐ 这个号名下还有没有没到的预约 —— 「发了 CANCEL 但预约还在」就是靠它认出来的 */
  upcoming: Array<{ appointmentId: string; startsAt: string; confirmationCode: string | null }>;
}

export async function loadInboundSms(
  tx: postgres.TransactionSql, ctx: CommandContext, days = 14,
): Promise<{ messages: InboundSms[]; needsAttention: number }> {
  const rows = await tx<{
    id: string; from_e164: string; body: string; intent: string; received_at: string;
  }[]>`
    select id, from_e164, body, intent, received_at::text as received_at
    from sms_inbound
    where received_at > now() - (${days} || ' days')::interval
      and routing_scope = 'store'
      and resolved_org = ${ctx.orgId}
      and resolved_location = ${ctx.locationId}
    order by received_at desc
    limit 100`;
  if (rows.length === 0) return { messages: [], needsAttention: 0 };

  const froms = [...new Set(rows.map((r) => r.from_e164))];

  const custs = await tx<{ id: string; display_name: string; phone_e164: string }[]>`
    select id, display_name, phone_e164 from customers
    where org_id = ${ctx.orgId} and phone_e164 = any(${froms})`;

  const appts = await tx<{
    id: string; starts_at: string; confirmation_code: string | null; phone_e164: string;
  }[]>`
    select a.id, a.starts_at::text as starts_at, a.confirmation_code, c.phone_e164
    from appointments a
    join customers c on c.id = a.customer_id
    where a.location_id = ${ctx.locationId}
      and c.phone_e164 = any(${froms})
      and a.status not in ('cancelled','completed','no_show')
      and a.starts_at > now()
    order by a.starts_at`;

  const messages = rows.map((r) => ({
    id: r.id,
    fromE164: r.from_e164,
    body: r.body,
    intent: r.intent,
    receivedAt: r.received_at,
    customers: custs.filter((c) => c.phone_e164 === r.from_e164)
      .map((c) => ({ id: c.id, name: c.display_name })),
    upcoming: appts.filter((a) => a.phone_e164 === r.from_e164)
      .map((a) => ({
        appointmentId: a.id, startsAt: a.starts_at, confirmationCode: a.confirmation_code,
      })),
  }));

  /**
   * ⭐ 「要处理」= **退了订、而且名下还有没到的预约**。
   *
   * 这正是 CANCEL 那个坑的形状：他以为取消了，实际只是退订。
   * 单纯的退订不算（那是他的权利，前台不用做什么），
   * 单纯的问句也不算（我们本来就不做短信对话）。
   */
  const needsAttention = messages
    .filter((m) => m.intent === 'opt_out' && m.upcoming.length > 0).length;

  return { messages, needsAttention };
}
