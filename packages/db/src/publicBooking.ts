/**
 * `public_key` 维度的解析 —— 和 device.ts / identity.ts / phone.ts 同一个思路。
 *
 * 门店官网打进来时我们不知道 org_id：能用的只有一个公开标识。
 * 和「登录后还没选店」「webhook 只带一个被叫号码」一样，
 * **缺的是上下文，不是权限**。
 *
 * `withPublicKey` 设 `app.public_key` 且不设 org_id，sql/0033 里的策略
 * 只放行 **key 恰好相等**的那一行。于是：翻不出门店表、猜不出别的店的 key、
 * 也不需要 service_role（宪法第 5 条）。
 *
 * ⚠️ 这里解析出来的上下文**只够用来认出是哪家店**。真正的读写在
 * 认出之后走正常的 withTenant —— 和门口 iPad 一模一样。
 */

import { sql } from './client';

/** `pk_` + 24 位 hex（sql/0033 的触发器保证）。老库里的 8 位在迁移时已换掉 */
const KEY_RE = /^pk_[0-9a-f]{16,64}$/;

export interface OnlineBookingConfig {
  enabled: boolean;
  maxDaysAhead: number;
  minMinutesAhead: number;
  requirePhoneVerification: boolean;
  cancelCutoffHours: number;
}

export interface PublicShopRow {
  orgId: string;
  locationId: string;
  name: Record<string, string>;
  slug: string;
  timezone: string;
  currency: string;
  businessDayCutoff: string;
  businessHours: Record<string, { open: string; close: string } | null>;
  address: Record<string, unknown> | null;
  phone: string | null;
  locationStatus: string;
  defaultLocale: string;
  onlineBooking: OnlineBookingConfig;
  /** 规范化过的 origin 列表。空数组 = 老板还没填，见 publicAuth.ts 的取舍 */
  allowedOrigins: string[];
  settings: Record<string, unknown>;
}

/** settings.online_booking 缺字段时的安全默认值。**enabled 默认 false** */
export function readOnlineBooking(settings: Record<string, unknown>): OnlineBookingConfig {
  const raw = (settings['online_booking'] ?? {}) as Record<string, unknown>;
  const num = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  return {
    enabled: raw['enabled'] === true,
    maxDaysAhead: num(raw['max_days_ahead'], 60),
    minMinutesAhead: num(raw['min_minutes_ahead'], 120),
    requirePhoneVerification: raw['require_phone_verification'] === true,
    cancelCutoffHours: num(raw['cancel_cutoff_hours'], 4),
  };
}

/**
 * 拿一个公开 key 换门店上下文。认不出返回 null —— 调用方一律翻成 404，
 * **不区分**「没这个 key」和「这家店停用了」，那个区别只对想试探的人有用。
 */
export async function withPublicKey(publicKey: string): Promise<PublicShopRow | null> {
  if (!KEY_RE.test(publicKey)) return null;

  return sql.begin(async (tx) => {
    // 显式清空 org_id：连接是复用的，带进上一个请求的值会让这次查询
    // 变成「在那个租户里找这家店」—— 找不到还算好的，找到了就是串店
    await tx`select
      set_config('app.public_key',        ${publicKey}, true),
      set_config('app.org_id',            '',           true),
      set_config('app.location_id',       '',           true),
      set_config('app.user_id',           '',           true),
      set_config('app.device_token_hash', '',           true)`;

    const rows = await tx<{
      org_id: string; location_id: string; name: unknown; slug: string;
      timezone: string; currency: string; cutoff: string; hours: unknown;
      address: unknown; phone: string | null; loc_status: string;
      locale: string; settings: unknown;
    }[]>`
      select l.org_id, l.id as location_id, l.name, l.slug, l.timezone, l.currency,
             l.business_day_cutoff::text as cutoff, l.business_hours as hours,
             l.address, l.phone, l.status as loc_status,
             o.default_locale as locale, l.settings
      from locations l
      join organizations o on o.id = l.org_id
      where l.public_key = ${publicKey}`;

    const r = rows[0];
    if (!r) return null;

    const origins = await tx<{ origin: string }[]>`
      select origin from location_allowed_origins
      where location_id = ${r.location_id}`;

    const settings = (r.settings ?? {}) as Record<string, unknown>;

    return {
      orgId: r.org_id,
      locationId: r.location_id,
      name: (r.name ?? {}) as Record<string, string>,
      slug: r.slug,
      timezone: r.timezone,
      currency: r.currency,
      businessDayCutoff: r.cutoff,
      businessHours: (r.hours ?? {}) as PublicShopRow['businessHours'],
      address: (r.address ?? null) as Record<string, unknown> | null,
      phone: r.phone,
      locationStatus: r.loc_status,
      defaultLocale: r.locale,
      onlineBooking: readOnlineBooking(settings),
      allowedOrigins: origins.map((o) => o.origin),
      settings,
    };
  }) as Promise<PublicShopRow | null>;
}
