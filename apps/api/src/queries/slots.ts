/**
 * 「什么时候有空」—— 把库里的班表和已占用时段喂给排期引擎。
 *
 * 这个文件里**没有任何排期逻辑**，逻辑全在 `@gf/scheduling` 的 `findOpenSlots`
 * （纯函数、有测试，宪法第 2 条）。这里只负责取数：谁今天上班、
 * 上到几点、已经被占了哪几段。
 *
 * 两个调用方共用它 —— 电话 AI 的 `find_slots` 工具，和前台的「最近有空」。
 * 两边看到的必须是同一份答案，否则 AI 在电话里报的时间前台会说没有。
 */

import type postgres from 'postgres';
import {
  findOpenSlots, summariseSlots, businessDateOf, wallMinuteToInstant,
  type OpenSlot, type StaffAvailability,
} from '@gf/scheduling';

export interface SlotContext {
  businessDate: string;
  timezone: string;
  slots: OpenSlot[];
}

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

const hhmmToMin = (v: string): number => {
  const [h = '0', m = '0'] = v.split(':');
  return Number(h) * 60 + Number(m);
};

/**
 * 找出 `around` 那一天、能放下 `durationMin` 的空档。
 *
 * `preferredMembershipId` 给了就只在那个人身上找 —— 客人点名要 Amy 时，
 * 报一堆「Linh 有空」在电话里是彻底的答非所问。
 */
export interface SlotOptions {
  limit?: number;
  windowStartMin?: number;
  windowEndMin?: number;
  /**
   * ⭐ 只找这个性别的技师（`male` / `female`）。
   *
   * 在 **SQL 这一层**就把班表收窄，而不是拿到空档再过滤 ——
   * 后者会漏掉本可安排的时段（见 `findOpenSlots` 的 candidateMembershipIds）。
   */
  genderPreference?: string | null;
  /** 同行几位客人。>1 时同一时刻要有这么多位技师同时有空 */
  partySize?: number;
}

export async function loadSlotContext(
  tx: postgres.TransactionSql,
  locationId: string,
  around: Date,
  durationMin: number,
  preferredMembershipId: string | null,
  opts: SlotOptions = {},
): Promise<SlotContext> {
  const [loc] = await tx<{
    tz: string; cutoff: string; hours: Record<string, { open: string; close: string } | null>;
    settings: Record<string, unknown>;
  }[]>`
    select timezone as tz, business_day_cutoff::text as cutoff,
           business_hours as hours, settings
    from locations where id = ${locationId}`;
  if (!loc) return { businessDate: '', timezone: 'UTC', slots: [] };

  const businessDate = businessDateOf(around, loc.tz, loc.cutoff);

  // 营业时间。那一天不营业就直接没有空档 —— 报一个「周日 14:00」
  // 而店里周日关门，客人会白跑一趟
  const weekday = DAY_KEYS[new Date(`${businessDate}T12:00:00Z`).getUTCDay()]!;
  const today = loc.hours?.[weekday];
  if (!today) return { businessDate, timezone: loc.tz, slots: [] };

  const openMin = hhmmToMin(today.open);
  // 跨午夜（足疗店开到凌晨 1:00）：close < open 时加一天，
  // 否则窗口是负的，一个空档都算不出来
  const rawClose = hhmmToMin(today.close);
  const closeMin = rawClose <= openMin ? rawClose + 24 * 60 : rawClose;

  // ── 谁今天上班 ──────────────────────────────────────────────────────────
  //
  // 只取 published 的班。planned 的还没发给技师，拿它给客人报时间
  // 等于替技师答应了一个他还不知道的班。
  const staffRows = await tx<{
    membership_id: string; name: unknown; start_min: number; end_min: number;
    max_concurrent: number; gender: string | null;
  }[]>`
    select s.membership_id, sp.display_name as name, s.start_min, s.end_min,
           sp.max_concurrent_appointments as max_concurrent, sp.gender
    from shifts s
    join staff_profiles sp on sp.membership_id = s.membership_id
    join memberships m on m.id = s.membership_id and m.status = 'active'
    where s.location_id = ${locationId}
      and s.business_date = ${businessDate}
      and s.status = 'published'
      and sp.is_bookable = true
    order by sp.display_name->>'en'`;

  if (staffRows.length === 0) return { businessDate, timezone: loc.tz, slots: [] };

  // ── 已经占着的时段 ──────────────────────────────────────────────────────
  //
  // ⚠️ 这里**不再**过滤 `membership_id is not null`：还没派技师的单
  //    照样占着店里的位置，门店层容量要算上它们。
  //    按人分组时再把 null 的那些跳过。
  const busyRows = await tx<{
    membership_id: string | null; starts_at: string | Date; ends_at: string | Date;
  }[]>`
    select ai.membership_id, ai.starts_at, ai.ends_at
    from appointment_items ai
    join appointments a on a.id = ai.appointment_id
    where a.location_id = ${locationId}
      and a.business_date = ${businessDate}
      and a.status <> 'cancelled'`;

  const busyBy = new Map<string, Array<{ startsAt: Date; endsAt: Date }>>();
  const locationBusy: Array<{ startsAt: Date; endsAt: Date }> = [];
  for (const b of busyRows) {
    const iv = { startsAt: new Date(b.starts_at), endsAt: new Date(b.ends_at) };
    locationBusy.push(iv);
    if (!b.membership_id) continue;
    if (!busyBy.has(b.membership_id)) busyBy.set(b.membership_id, []);
    busyBy.get(b.membership_id)!.push(iv);
  }

  const staff: StaffAvailability[] = staffRows.map((r) => ({
    membershipId: r.membership_id,
    name: pickName(r.name),
    shiftStartMin: r.start_min,
    shiftEndMin: r.end_min,
    busy: busyBy.get(r.membership_id) ?? [],
    maxConcurrent: r.max_concurrent ?? 1,
  }));

  // 「现在」之后才算数。客人下午两点打电话，报上午十点有空是荒唐的。
  // 只有当天才卡这一条 —— 查明天的空档时 nowMin 没有意义
  const todayHere = businessDateOf(new Date(), loc.tz, loc.cutoff);
  const nowMin = todayHere === businessDate ? minutesNowIn(loc.tz) : undefined;

  const capacity = (loc.settings as {
    capacity?: { slot_minutes?: number; max_concurrent_per_slot?: number | null };
  })?.capacity;
  const slotMinutes = Number(capacity?.slot_minutes ?? 15);
  const perSlot = capacity?.max_concurrent_per_slot;

  /**
   * 性别偏好 → 候选 membership 集。
   *
   * 匹配不上任何人时给一个**空数组**而不是 null：null 是「不限」，
   * 空数组是「一个符合条件的都没有」。这两件事在电话里天差地别 ——
   * 前者会让 AI 报出一堆男技师的时间，而客人要的是女技师。
   */
  const candidateMembershipIds = opts.genderPreference
    ? staffRows.filter((r) => r.gender === opts.genderPreference).map((r) => r.membership_id)
    : null;

  const slots = findOpenSlots({
    businessDate,
    timezone: loc.tz,
    openMin,
    closeMin,
    durationMin,
    staff,
    slotMinutes: Number.isFinite(slotMinutes) && slotMinutes > 0 ? slotMinutes : 15,
    preferredMembershipId,
    candidateMembershipIds,
    partySize: opts.partySize ?? 1,
    location: {
      maxConcurrentPerSlot: typeof perSlot === 'number' ? perSlot : null,
      busy: locationBusy,
    },
    limit: opts.limit ?? 20,
    toInstant: wallMinuteToInstant,
    ...(nowMin !== undefined ? { nowMin } : {}),
    ...(opts.windowStartMin !== undefined ? { windowStartMin: opts.windowStartMin } : {}),
    ...(opts.windowEndMin !== undefined ? { windowEndMin: opts.windowEndMin } : {}),
  });

  return { businessDate, timezone: loc.tz, slots };
}

/** 电话里报的那两三个时间 */
export { summariseSlots };

function pickName(v: unknown): string {
  if (typeof v === 'string') return v;
  const o = (v ?? {}) as Record<string, string>;
  return o['en'] ?? o['zh-Hans'] ?? Object.values(o)[0] ?? '技师';
}

/** 门店此刻的墙上分钟 */
function minutesNowIn(timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return h * 60 + m;
}
