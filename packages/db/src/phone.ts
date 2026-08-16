/**
 * 号码维度的解析 —— 和 identity.ts 是同一个思路，不绕过任何东西。
 *
 * Telnyx 的 webhook 打进来时我们不知道 org_id：能用的只有一个被叫号码。
 * 这看起来像「必须绕过 RLS」的场景，但和登录后还没选店一样，
 * **缺的是一个上下文，不是权限**。
 *
 * `withPhoneLine` 设 `app.phone_lookup = <那个号码>` 且不设 org_id，
 * sql/0015 里的 `phone_line_lookup` 策略只放行 **e164 恰好等于它** 的那一行。
 * 于是：查不了别人的号码、枚举不出号码表、也不需要 service_role。
 *
 * ⚠️ 这个连接**只能**用来把号码换成 org/location。换到之后必须重新用
 * `withTenant` 开一个正常的租户上下文去做别的事 —— 这里的上下文没有 org_id，
 * 任何业务表都查不出东西来（这正是我们要的）。
 */

import postgres from 'postgres';
import { sql } from './client';

/** E.164 之外的一律不接受 —— 这个值要进 current_setting，越窄越好 */
const E164_RE = /^\+[1-9]\d{7,14}$/;

export async function withPhoneLine<T>(
  e164: string,
  fn: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  if (!E164_RE.test(e164)) throw new Error(`withPhoneLine: 不是合法 E.164 号码：${e164}`);
  return sql.begin(async (tx) => {
    // 显式清空 org_id / location_id：连接是复用的，万一带进上一个请求的值，
    // 这里的查询就会变成「在那个租户里找这个号码」——
    // 找不到还算好的，找到了就是串店
    await tx`select
      set_config('app.phone_lookup', ${e164}, true),
      set_config('app.org_id',       '',      true),
      set_config('app.location_id',  '',      true),
      set_config('app.user_id',      '',      true)`;
    return fn(tx);
  }) as Promise<T>;
}

export interface PhoneLineTenant {
  orgId: string;
  locationId: string;
  timezone: string;
  locale: string;
  assistantId: string | null;
}

/** 被叫号码 → 门店。停用的线不算数（换号期间旧号码要能立刻断掉）。 */
export async function tenantForPhoneNumber(e164: string): Promise<PhoneLineTenant | null> {
  const rows = await withPhoneLine(e164, (tx) => tx<{
    org_id: string; location_id: string; tz: string;
    locale: string; assistant_id: string | null;
  }[]>`
    select p.org_id, p.location_id, l.timezone as tz,
           o.default_locale as locale, p.assistant_id
    from phone_lines p
    join locations l on l.id = p.location_id
    join organizations o on o.id = p.org_id
    where p.e164 = ${e164} and p.active = true`);

  const r = rows[0];
  return r ? {
    orgId: r.org_id,
    locationId: r.location_id,
    timezone: r.tz,
    locale: r.locale,
    assistantId: r.assistant_id,
  } : null;
}
