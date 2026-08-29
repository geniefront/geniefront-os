/**
 * 设备令牌维度的解析 —— 和 identity.ts / phone.ts 同一个思路，不绕过 RLS。
 *
 * 门口那台 iPad 打进来时我们不知道 org_id：能用的只有一个令牌摘要。
 * 和「登录后还没选店」「webhook 只带一个被叫号码」一样，
 * **缺的是上下文，不是权限**。
 *
 * `withDeviceToken` 设 `app.device_token_hash` 且不设 org_id，
 * sql/0016 里的策略只放行**摘要恰好相等**的那一行。
 * 于是：翻不出设备表、猜不出别的店的令牌、也不需要 service_role。
 */

import { sql } from './client';

/** SHA-256 的十六进制摘要 */
const HASH_RE = /^[0-9a-f]{64}$/;

export interface DeviceTokenRow {
  id: string;
  orgId: string;
  locationId: string;
  label: string;
  tokenHash: string;
  revokedAt: Date | string | null;
  timezone: string;
  defaultLocale: string;
  locationStatus: string;
  terminalType: 'customer-facing' | 'kiosk' | null;
}

export async function withDeviceToken(tokenHash: string): Promise<DeviceTokenRow | null> {
  if (!HASH_RE.test(tokenHash)) {
    throw new Error('withDeviceToken: 参数必须是 SHA-256 的十六进制摘要');
  }

  return sql.begin(async (tx) => {
    // 显式清空 org_id：连接是复用的，带进上一个请求的值会让这次查询
    // 变成「在那个租户里找这个设备」—— 找不到还算好的，找到了就是串店
    await tx`select
      set_config('app.device_token_hash', ${tokenHash}, true),
      set_config('app.org_id',            '',           true),
      set_config('app.location_id',       '',           true),
      set_config('app.user_id',           '',           true)`;

    const rows = await tx<{
      id: string; org_id: string; location_id: string; label: string;
      token_hash: string; revoked_at: Date | string | null;
      terminal_type: 'customer-facing' | 'kiosk' | null;
      tz: string; locale: string; loc_status: string;
    }[]>`
      select d.id, d.org_id, d.location_id, d.label, d.token_hash, d.revoked_at,
             d.terminal_type,
             l.timezone as tz, o.default_locale as locale, l.status as loc_status
      from device_tokens d
      join locations l on l.id = d.location_id
      join organizations o on o.id = d.org_id
      where d.token_hash = ${tokenHash}`;

    const r = rows[0];
    if (!r) return null;

    // 顺手记一下最后活跃时间 —— 老板要能在设置里看到「这台 iPad 还在不在用」，
    // 那是决定要不要吊销的唯一依据
    await tx`update device_tokens set last_seen_at = now() where id = ${r.id}`;

    return {
      id: r.id,
      orgId: r.org_id,
      locationId: r.location_id,
      label: r.label,
      tokenHash: r.token_hash,
      revokedAt: r.revoked_at,
      timezone: r.tz,
      defaultLocale: r.locale,
      locationStatus: r.loc_status,
      terminalType: r.terminal_type,
    };
  }) as Promise<DeviceTokenRow | null>;
}
