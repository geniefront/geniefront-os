/**
 * 短信同意状态与收件留档 —— **平台级**,不走 withTenant。
 *
 * ## 为什么这一处不分租户
 *
 * 所有门店的短信都从**同一个号**、以**同一个 10DLC brand** 发出去。
 * 客人回 STOP 是对**这个发送者**说的 —— 运营商会在网络层掐掉这个号
 * 到他的全部短信,不管是哪家店触发的。
 *
 * 按 org 存 opt-out 会造成:A 店收到 STOP、B 店照发。客人看到的是
 * 「我明明退订了还在发」,运营商看到的是我们无视 STOP —— 两边都是真麻烦。
 *
 * 而且入站 webhook **根本没有租户上下文**:`to` 是平台号,不属于任何一家店。
 * 这和设备令牌、被叫号码那两条路是同一种情况 ——
 * **缺的是上下文,不是权限**(sql/0034 的策略是 `using (true)`,
 * RLS 仍然开着,只是有意敞开,能在 pg_policies 里查得到)。
 */

import { normalizePhoneE164 } from '@gf/contracts';
import { sql } from './client';

const E164 = /^\+[1-9]\d{7,14}$/;

export type SmsConsentState = 'opted_out' | 'opted_in';
export type SmsIntentRecord = 'opt_out' | 'opt_in' | 'help' | 'unknown';

/** 这个号现在还让不让我们发。查不到 = 从没退订过 = 能发 */
export async function smsOptedOut(phoneE164: string): Promise<boolean> {
  if (!E164.test(phoneE164)) return true;   // 号码本身不对,不发
  const rows = await sql<{ state: string }[]>`
    select state from sms_consent where phone_e164 = ${phoneE164}`;
  return rows[0]?.state === 'opted_out';
}

/** 批量版 —— flush 一次要判一批,一条一条查是白扔往返 */
export async function smsOptedOutSet(phones: readonly string[]): Promise<Set<string>> {
  const list = phones.filter((p) => E164.test(p));
  if (list.length === 0) return new Set();
  const rows = await sql<{ phone_e164: string }[]>`
    select phone_e164 from sms_consent
    where phone_e164 = any(${list as string[]}) and state = 'opted_out'`;
  return new Set(rows.map((r) => r.phone_e164));
}

/** 记一次同意状态变更。同一个号反复发 STOP 是常事 —— upsert,不报错 */
export async function setSmsConsent(
  phoneE164: string, state: SmsConsentState, keyword: string | null,
): Promise<void> {
  if (!E164.test(phoneE164)) return;
  await sql`
    insert into sms_consent (phone_e164, state, keyword, updated_at)
    values (${phoneE164}, ${state}, ${keyword}, now())
    on conflict (phone_e164) do update
      set state = excluded.state, keyword = excluded.keyword, updated_at = now()`;
}

/**
 * 收件留档。**每一条都记**,不只是认得出的那几个关键词。
 *
 * ⚠️ 认不出的那些(`unknown`)恰恰是最该留的:客人以为能用短信改预约,
 * 发了一句「can I move to 4pm」—— 我们不处理,但至少要有据可查,
 * 而不是让它凭空消失。
 *
 * ## 归属在这一刻定死（sql/0115，计划 §3.3）
 *
 * webhook 到达时没有租户上下文，`to` 可能是平台共享号。落库时按可靠证据
 * 把归属写进 `routing_scope` / `resolved_org` / `resolved_location`，之后
 * 读取（RLS 与查询层）只认这几列，不再现场反查 `phone_lines` —— 号码换绑
 * 后新持有者读不到旧持有者名下的历史短信。
 *
 *   1. `to` 命中门店专属线（`gf_sms_line_owner`）→ store。
 *   2. `to` 是平台共享号，且**恰好一家店**对这个发件号发过站内短信
 *      （`gf_sms_outbox_owner` —— 唯一的会话归属证据，不是「同号客户」也不是
 *      「最近发过」）→ store。
 *   3. 其余 → platform（系统关键词）/ unresolved：对所有租户不可见，
 *      按用户给出的降级许可（计划 §3.2.5）。
 *
 * E.164 先规范化再解析：`gf_sms_line_owner` / `gf_sms_outbox_owner` 都按字符串
 * 精确相等匹配，上游若送非规范写法（少了 `+`、带分隔符）会解析不到而误判。
 */
export async function recordInboundSms(m: {
  fromE164: string; toE164: string; body: string;
  intent: SmsIntentRecord; providerId?: string | null;
}): Promise<void> {
  const from = normalizePhoneE164(m.fromE164) ?? m.fromE164;
  const to = normalizePhoneE164(m.toE164) ?? m.toE164;

  const scope = await resolveInboundRouting(from, to, m.intent);

  try {
    await sql`
      insert into sms_inbound (
        from_e164, to_e164, body, intent, provider_id,
        routing_scope, bound_line_id, resolved_org, resolved_location, resolved_at
      ) values (
        ${from}, ${to}, ${m.body.slice(0, 2000)}, ${m.intent}, ${m.providerId ?? null},
        ${scope.routingScope}, ${scope.boundLineId}, ${scope.resolvedOrg},
        ${scope.resolvedLocation}, ${scope.resolvedOrg ? new Date().toISOString() : null}
      )`;
  } catch (e) {
    // webhook 重放：`sms_inbound_provider_id` 唯一索引挡下重复行。
    // 不能用 `on conflict do nothing` —— 那会触发 SELECT 策略检查，而
    // platform / unresolved 归属的行对任何租户都不可见，会被误判成越权。
    // 捕获唯一冲突（23505）当作幂等成功：重放不增加未读、不重复通知。
    if ((e as { code?: string }).code !== '23505') throw e;
  }
}

interface InboundRouting {
  routingScope: 'store' | 'platform' | 'unresolved';
  boundLineId: string | null;
  resolvedOrg: string | null;
  resolvedLocation: string | null;
}

async function resolveInboundRouting(
  fromE164: string, toE164: string, intent: SmsIntentRecord,
): Promise<InboundRouting> {
  // 1. 发到门店专属线：归属确定。
  const line = await sql<{ org_id: string; location_id: string; line_id: string }[]>`
    select org_id, location_id, line_id from gf_sms_line_owner(${toE164})`;
  if (line[0]) {
    return {
      routingScope: 'store',
      boundLineId: line[0].line_id,
      resolvedOrg: line[0].org_id,
      resolvedLocation: line[0].location_id,
    };
  }

  // 2. 平台共享号：只有恰好一家店与这个号有过站内短信会话时才唯一可归属。
  const owners = await sql<{ org_id: string; location_id: string }[]>`
    select org_id, location_id from gf_sms_outbox_owner(${fromE164})`;
  if (owners.length === 1) {
    return {
      routingScope: 'store',
      boundLineId: null,
      resolvedOrg: owners[0]!.org_id,
      resolvedLocation: owners[0]!.location_id,
    };
  }

  // 3. 无可靠证据：系统关键词交平台处理，其余降级隐藏。两者都对租户不可见。
  return {
    routingScope: intent === 'unknown' ? 'unresolved' : 'platform',
    boundLineId: null,
    resolvedOrg: null,
    resolvedLocation: null,
  };
}
