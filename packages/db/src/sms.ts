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
 */
export async function recordInboundSms(m: {
  fromE164: string; toE164: string; body: string;
  intent: SmsIntentRecord; providerId?: string | null;
}): Promise<void> {
  await sql`
    insert into sms_inbound (from_e164, to_e164, body, intent, provider_id)
    values (${m.fromE164}, ${m.toE164}, ${m.body.slice(0, 2000)},
            ${m.intent}, ${m.providerId ?? null})`;
}
