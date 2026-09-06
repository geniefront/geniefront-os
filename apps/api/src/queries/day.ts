/**
 * 当日现场快照 —— 日程表、开单页、（以后）AI 副驾都吃这一份。
 *
 * 一次给全，不让前端拼十个接口：门店网络差，一次往返比十次可靠得多。
 */

import type postgres from 'postgres';
import { parseTs } from '@gf/db';
import { pickText, type CommandContext } from '@gf/contracts';
import { deskOpenCloseMin } from './deskHours';

export interface DayStaff {
  membershipId: string;
  name: string;
  isBookable: boolean;
  inRotation: boolean;
  maxConcurrent: number;
  color: string | null;
  levelName: string | null;
  skills: Array<{ id: string; key: string; name: string }>;
}

export interface DayItem {
  itemId: string;
  appointmentId: string;
  membershipId: string | null;
  customerName: string;
  /** 客户档案电话。没有档案（纯 walk-in 未留号）时为 null。 */
  customerPhone: string | null;
  /**
   * 实际完工时刻（ticket_items.finished_at）。
   * 没有开工记录时为 null，看板不得拿预约 ends_at 冒充。
   */
  completedAt: string | null;
  /**
   * ⭐ 项目 id。**别拿 `serviceName` 去 `services[]` 里回查** ——
   * 那条路有三个会静默出错的地方：
   *   · `services[]` 只含 `active = true` 的，而已下架项目的旧单照样在 items 里
   *   · 项目名没有唯一约束，两个同名项目会查到错的那一个
   *   · 名字是按当前 locale 渲染过的，改一次 i18n 文案就全对不上了
   */
  serviceId: string;
  serviceName: string;
  startsAt: string;
  endsAt: string;
  durationMin: number;
  status: string;
  isRequest: boolean;
  overbooked: boolean;
  overbookReason: string | null;
  resourceId: string | null;
}

export interface DayService {
  id: string;
  name: string;
  categoryId: string | null;
  categoryName: string | null;
  durationMin: number;
  priceCents: number;
  staffCount: number;
  requiredSkills: Array<{ id: string; key: string; name: string }>;
}

export interface DaySnapshot {
  businessDate: string;
  timezone: string;
  openMin: number;   // 当天营业起止，用分钟表示（本地墙上时间）
  closeMin: number;
  staff: DayStaff[];
  services: DayService[];
  resources: Array<{ id: string; name: string; capacity: number; maxStaff: number | null }>;
  items: DayItem[];
}


export async function loadDay(
  tx: postgres.TransactionSql,
  ctx: CommandContext,
  businessDate: string,
): Promise<DaySnapshot> {
  const [loc] = await tx<{ timezone: string; business_hours: unknown }[]>`
    select timezone, business_hours from locations where id = ${ctx.locationId}`;

  const staffRows = await tx<{
    membership_id: string; display_name: unknown; is_bookable: boolean;
    max_concurrent: number; color: string | null; in_rotation: boolean | null;
    level_name: unknown; skills: unknown;
  }[]>`
    select sp.membership_id, sp.display_name, sp.is_bookable,
           sp.max_concurrent_appointments as max_concurrent, sp.color,
           rp.in_rotation, sl.name as level_name,
           coalesce((select jsonb_agg(jsonb_build_object('id', sk.id, 'key', sk.key, 'name', sk.name) order by sk.key)
             from staff_skills ss join skills sk on sk.id = ss.skill_id
             where ss.membership_id = sp.membership_id), '[]'::jsonb) as skills
    from staff_profiles sp
    left join rotation_participants rp
      on rp.membership_id = sp.membership_id and rp.business_date = ${businessDate}
    join memberships m on m.id = sp.membership_id and m.status = 'active'
    left join staff_levels sl on sl.id = sp.level_id
    where sp.location_id = ${ctx.locationId}
    order by sp.is_bookable desc, sp.display_name->>'en'`;

  const serviceRows = await tx<{
    id: string; name: unknown; duration_min: number; base_price_cents: number;
    category_id: string | null; category_name: unknown; staff_count: number; required_skills: unknown;
  }[]>`
    select s.id, s.name, s.category_id, sc.name as category_name,
           s.duration_min, s.base_price_cents, s.staff_count,
           coalesce((select jsonb_agg(jsonb_build_object('id', sk.id, 'key', sk.key, 'name', sk.name) order by sk.key)
             from service_skill_requirements ssr join skills sk on sk.id = ssr.skill_id
             where ssr.service_id = s.id), '[]'::jsonb) as required_skills
    from services s
    left join service_categories sc on sc.id = s.category_id
    where s.location_id = ${ctx.locationId} and s.active = true
    order by s.sort, s.name->>'en'`;

  // ⭐ 带上 capacity：一间房不等于一张床（决策 25）。
  // 足疗房排 6 张躺椅、双人房两张床 —— 房态看板要画「3/6 位」而不是「占用」，
  // 只回 {id,name} 的话前台看到「占用」就不敢再往里排人了
  const resourceRows = await tx<{
    id: string; name: string; capacity: number; max_staff: number | null;
  }[]>`
    select id, name, capacity, max_staff from resources
    where location_id = ${ctx.locationId} and status <> 'out_of_service'
    order by name`;

  const itemRows = await tx<{
    item_id: string; appointment_id: string; membership_id: string | null;
    customer_name: string | null; walk_in_name: string | null; customer_phone: string | null;
    service_id: string; service_name: unknown;
    starts_at: string; ends_at: string; duration_min: number; status: string;
    is_request: boolean; overbooked: boolean; overbook_reason: string | null;
    resource_id: string | null; completed_at: string | null;
  }[]>`
    select ai.id as item_id, ai.appointment_id, ai.membership_id,
           c.display_name as customer_name, a.walk_in_name, c.phone_e164 as customer_phone,
           ai.service_id, s.name as service_name,
           ai.starts_at, ai.ends_at, ai.duration_min, ai.status,
           ai.is_request, ai.overbooked, ai.overbook_reason, ai.resource_id,
           (
             select max(ti.finished_at)
             from tickets tk
             join ticket_items ti on ti.ticket_id = tk.id
             where tk.appointment_id = a.id
               and tk.location_id = ai.location_id
               and ti.finished_at is not null
           ) as completed_at
    from appointment_items ai
    join appointments a on a.id = ai.appointment_id
    join services s on s.id = ai.service_id
    left join customers c on c.id = a.customer_id
    where ai.location_id = ${ctx.locationId}
      and a.business_date = ${businessDate}
      and ai.status <> 'cancelled'
    order by ai.starts_at`;

  const hours = deskOpenCloseMin(businessDate, loc?.business_hours);

  return {
    businessDate,
    timezone: loc?.timezone ?? 'America/New_York',
    openMin: hours.openMin,
    closeMin: hours.closeMin,
    staff: staffRows.map((s) => ({
      membershipId: s.membership_id,
      name: pickText(s.display_name, ctx.locale),
      isBookable: s.is_bookable,
      // rotation_participants 没有当天记录时，默认「可接客的人参与轮牌」
      inRotation: s.in_rotation ?? s.is_bookable,
      maxConcurrent: s.max_concurrent,
      color: s.color,
      levelName: s.level_name ? pickText(s.level_name, ctx.locale) : null,
      skills: Array.isArray(s.skills) ? s.skills.map((skill) => {
        const value = skill as { id: string; key: string; name: unknown };
        return { id: value.id, key: value.key, name: pickText(value.name, ctx.locale, value.key) };
      }) : [],
    })),
    services: serviceRows.map((s) => ({
      id: s.id,
      name: pickText(s.name, ctx.locale),
      categoryId: s.category_id,
      categoryName: s.category_name ? pickText(s.category_name, ctx.locale) : null,
      durationMin: s.duration_min,
      priceCents: s.base_price_cents,
      staffCount: s.staff_count,
      requiredSkills: Array.isArray(s.required_skills) ? s.required_skills.map((skill) => {
        const value = skill as { id: string; key: string; name: unknown };
        return { id: value.id, key: value.key, name: pickText(value.name, ctx.locale, value.key) };
      }) : [],
    })),
    resources: resourceRows.map((r) => ({
      id: r.id, name: r.name, capacity: r.capacity, maxStaff: r.max_staff,
    })),
    items: itemRows.map((r) => ({
      itemId: r.item_id,
      appointmentId: r.appointment_id,
      membershipId: r.membership_id,
      customerName: r.customer_name ?? r.walk_in_name ?? '临时客人',
      customerPhone: r.customer_phone,
      serviceId: r.service_id,
      serviceName: pickText(r.service_name, ctx.locale),
      startsAt: parseTs(r.starts_at).toISOString(),
      endsAt: parseTs(r.ends_at).toISOString(),
      completedAt: r.completed_at ? parseTs(r.completed_at).toISOString() : null,
      durationMin: r.duration_min,
      status: r.status,
      isRequest: r.is_request,
      overbooked: r.overbooked,
      overbookReason: r.overbook_reason,
      resourceId: r.resource_id,
    })),
  };
}
