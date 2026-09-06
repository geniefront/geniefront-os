/**
 * 门店档案取数（副驾稳定上下文段）
 *
 * 这一段会被拼进模型的 instructions，也就是 OpenAI 前缀缓存的命中范围内，
 * 所以有一条硬要求：**同样的门店数据必须产出逐字节一致的结果**。
 *
 * 具体到这个文件就是「每一条 SQL 都必须有确定的 ORDER BY」——
 * 少一个排序，Postgres 换一次执行计划，行序一变，整段缓存就失效，
 * 而且是那种没人会发现的失效（结果完全正确，只是每次都全价付钱）。
 *
 * 格式化在 `@gf/ai` 的 `formatStoreProfile`（纯函数、有测试）。这里只查。
 */

import type postgres from 'postgres';
import { pickText, type CommandContext } from '@gf/contracts';
import type {
  StoreProfile,
  StoreProfileService,
  StoreProfileStaff,
  StoreProfileRoom,
  StoreProfilePackage,
} from '@gf/ai';

/** 与 formatStoreProfile 的 hours 数组一致：index 0 = 周日 */
const WEEKDAY_KEYS = [
  'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday',
] as const;
const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/**
 * `business_hours` 这一列历史上存过好几种键名（`monday` / `mon` / `1`），
 * 三种都认，认不出就当那天不营业。
 */
function readHours(
  raw: unknown,
): Array<{ weekday: string; open: string; close: string } | null> {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return WEEKDAY_KEYS.map((key, idx) => {
    const cell =
      obj[key] ?? obj[key.slice(0, 3)] ?? obj[String(idx)] ?? null;
    if (!cell || typeof cell !== 'object') return null;
    const c = cell as Record<string, unknown>;
    if (c['closed'] === true) return null;
    const open = c['open'] ?? c['start'];
    const close = c['close'] ?? c['end'];
    if (typeof open !== 'string' || typeof close !== 'string') return null;
    return { weekday: WEEKDAY_LABELS[idx]!, open, close };
  });
}

export async function loadStoreProfile(
  tx: postgres.TransactionSql,
  ctx: CommandContext,
): Promise<StoreProfile> {
  const [loc] = await tx<{
    name: unknown;
    tz: string;
    cutoff: string;
    phone: string | null;
    address_street: string | null;
    address_city: string | null;
    address_state: string | null;
    address_zip: string | null;
    business_hours: unknown;
  }[]>`
    select name, timezone as tz, business_day_cutoff::text as cutoff,
           phone, address_street, address_city, address_state, address_zip,
           business_hours
    from locations
    where id = ${ctx.locationId}`;

  const [tax] = await tx<{ rate: string }[]>`
    select sales_tax_rate_percent::text as rate
    from location_checkout_settings
    where location_id = ${ctx.locationId}`;

  // ── 服务目录 ──────────────────────────────────────────────────────────────
  const serviceRows = await tx<{
    id: string;
    name: unknown;
    duration_min: number;
    base_price_cents: number;
    category_name: unknown;
  }[]>`
    select s.id, s.name, s.duration_min, s.base_price_cents,
           sc.name as category_name
    from services s
    left join service_categories sc on sc.id = s.category_id
    where s.location_id = ${ctx.locationId} and s.active = true
    order by sc.sort nulls last, s.sort nulls last, s.name->>'en' nulls last, s.id`;

  const services: StoreProfileService[] = serviceRows.map((s) => {
    const nameObj = (s.name && typeof s.name === 'object' ? s.name : {}) as Record<string, string>;
    return {
      id: s.id,
      name: pickText(s.name, ctx.locale),
      englishName: nameObj['en'] || nameObj['en-US'] || null,
      category: s.category_name ? pickText(s.category_name, ctx.locale) : null,
      durationMin: s.duration_min,
      priceDollars: (s.base_price_cents / 100).toFixed(2),
    };
  });

  // ── 员工花名册（含技能）────────────────────────────────────────────────────
  //
  // 已离职的人不下发：他们既不能被排单，出现在名单里还会诱导模型把单派给他们。
  const staffRows = await tx<{
    membership_id: string;
    display_name: unknown;
    job_title: string | null;
    level_name: unknown;
    is_bookable: boolean;
    max_concurrent_appointments: number;
    status: string;
  }[]>`
    select sp.membership_id, sp.display_name, sp.job_title,
           sl.name as level_name, sp.is_bookable,
           sp.max_concurrent_appointments, m.status
    from staff_profiles sp
    join memberships m on m.id = sp.membership_id
    left join staff_levels sl on sl.id = sp.level_id
    where sp.location_id = ${ctx.locationId}
      and m.status <> 'resigned'
    order by sp.is_bookable desc, sp.employee_no nulls last, sp.membership_id`;

  const skillRows = await tx<{
    membership_id: string;
    key: string;
    name: unknown;
  }[]>`
    select ss.membership_id, sk.key, sk.name
    from staff_skills ss
    join skills sk on sk.id = ss.skill_id
    where sk.location_id = ${ctx.locationId}
    order by ss.membership_id, sk.key`;

  const skillsByMember = new Map<string, string[]>();
  for (const r of skillRows) {
    const list = skillsByMember.get(r.membership_id) ?? [];
    list.push(pickText(r.name, ctx.locale, r.key));
    skillsByMember.set(r.membership_id, list);
  }

  const staff: StoreProfileStaff[] = staffRows.map((s) => ({
    membershipId: s.membership_id,
    name: pickText(s.display_name, ctx.locale),
    jobTitle: s.job_title,
    level: s.level_name ? pickText(s.level_name, ctx.locale) : null,
    isBookable: s.is_bookable,
    maxConcurrent: s.max_concurrent_appointments,
    status: s.status,
    skills: skillsByMember.get(s.membership_id) ?? [],
  }));

  // ── 房间与工位 ────────────────────────────────────────────────────────────
  //
  // 这里刻意不带 status：房态是随时在变的「现在」，属于易变段；
  // 档案段只给「这家店有哪些房、多大」这种一年也不改一次的事实。
  const roomRows = await tx<{
    id: string;
    name: string;
    capacity: number;
    max_staff: number | null;
    type_key: string;
    type_name: unknown;
  }[]>`
    select r.id, r.name, r.capacity, r.max_staff,
           coalesce(rt.key, 'room') as type_key, rt.name as type_name
    from resources r
    left join resource_types rt on rt.id = r.resource_type_id
    where r.location_id = ${ctx.locationId}
    order by r.name, r.id`;

  const rooms: StoreProfileRoom[] = roomRows.map((r) => ({
    resourceId: r.id,
    name: r.name,
    type: r.type_name ? pickText(r.type_name, ctx.locale, r.type_key) : r.type_key,
    capacity: r.capacity,
    maxStaff: r.max_staff,
  }));

  // ── 次卡与套餐 ────────────────────────────────────────────────────────────
  const packageRows = await tx<{
    id: string;
    name: unknown;
    price_cents: number;
    sessions: number;
  }[]>`
    select id, name, price_cents, sessions
    from package_templates
    where location_id = ${ctx.locationId} and active = true
    order by sort nulls last, name->>'en' nulls last, id`;

  const packages: StoreProfilePackage[] = packageRows.map((p) => ({
    id: p.id,
    name: pickText(p.name, ctx.locale),
    priceDollars: (p.price_cents / 100).toFixed(2),
    sessions: p.sessions,
  }));

  const addressBits = [
    loc?.address_street,
    [loc?.address_city, loc?.address_state, loc?.address_zip].filter(Boolean).join(' '),
  ].filter((x) => x && String(x).trim());

  return {
    location: {
      name: pickText(loc?.name, ctx.locale),
      timezone: loc?.tz ?? 'America/New_York',
      cutoff: loc?.cutoff ?? '04:00',
      address: addressBits.length > 0 ? addressBits.join(', ') : null,
      phone: loc?.phone ?? null,
      hours: readHours(loc?.business_hours),
      taxPercent: tax?.rate ?? null,
    },
    services,
    staff,
    rooms,
    packages,
  };
}
