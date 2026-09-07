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
 * `sms_inbound` 是**平台级**的表（没有 org_id）。归属分两种情况（sql/0112）：
 *
 *   1. **发到本店专属线**（`phone_lines` 里 `ai_voice` / `sms` 的号，全局唯一，
 *      webhook 靠它反查门店）—— 归属确定，就是那条线指向的 org + location，
 *      跟发件人是不是别家客户没关系，**新客未建档也算**。
 *   2. **发到平台共享号**（没有任何门店在 `phone_lines` 里认领）—— 那条短信
 *      不属于任何一家店，只能靠「发件号码是本店客户」来推（沿用 sql/0079）。
 *
 * RLS（`inbound_select_own`，sql/0112）已经按同一套规则收窄了 SELECT；
 * 这里的显式过滤是纵深防御的第二道，改错一处不会漏。
 * 判断「某个被叫号是不是别家专属线」要跨 org，走 `gf_sms_line_owner()`
 * 这个极窄的 SECURITY DEFINER 函数，不自己 join `phone_lines`（会被 RLS 挡住）。
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
  /**
   * (1) 本店专属线（`ai_voice` / `sms`）。发到这些号的短信一律归本店，
   *     包括还没建档的新客咨询 —— 与发件人是不是别家客户无关。
   */
  const lineRows = await tx<{ e164: string }[]>`
    select e164 from phone_lines
    where org_id = ${ctx.orgId} and location_id = ${ctx.locationId}
      and purpose in ('ai_voice', 'sms') and active`;
  const ownLines = lineRows.map((r) => r.e164);

  /**
   * (2) 平台共享号的回落归属：发件号码是本店客户，且在本店有过预约。
   *
   * ⚠️ 走 `customers` 而不是直接扫 `sms_inbound`：平台共享号那条短信不属于
   * 任何一家店，只能靠「是我们的客人」来推。这条口径沿用 sql/0079，
   * 尚未细分同 org 两店（routingScope 工作项）。
   */
  const phones = await tx<{ phone_e164: string }[]>`
    select distinct c.phone_e164
    from customers c
    where c.org_id = ${ctx.orgId}
      and c.phone_e164 is not null
      and exists (
        select 1 from appointments a
        where a.customer_id = c.id and a.location_id = ${ctx.locationId})`;

  const custPhones = phones.map((p) => p.phone_e164);
  if (ownLines.length === 0 && custPhones.length === 0) {
    return { messages: [], needsAttention: 0 };
  }

  const rows = await tx<{
    id: string; from_e164: string; body: string; intent: string; received_at: string;
  }[]>`
    select id, from_e164, body, intent, received_at::text as received_at
    from sms_inbound
    where received_at > now() - (${days} || ' days')::interval
      and (
        to_e164 = any(${ownLines})
        or (
          from_e164 = any(${custPhones})
          and not exists (select 1 from gf_sms_line_owner(sms_inbound.to_e164))
        )
      )
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
