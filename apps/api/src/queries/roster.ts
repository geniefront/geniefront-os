/**
 * 排班表只读查询。
 *
 * 返回的是**墙上时间**（分钟）加上算好的真实工时 ——
 * 界面显示用前者（「10:00–19:00」），发工资用后者（DST 那天差一小时）。
 */

import type postgres from 'postgres';
import { pickText, type CommandContext } from '@gf/contracts';
import { addDays, shiftRealMinutes, weekdayOf, type Weekday } from '@gf/scheduling';

export interface RosterShift {
  membershipId: string;
  businessDate: string;
  startMin: number;
  endMin: number;
  breakMin: number;
  status: 'planned' | 'published' | 'off';
  offReason: string | null;
  note: string | null;
  fromTemplate: boolean;
  /** 真实流逝分钟（已扣休息）。off 为 0 */
  realMinutes: number;
}

export interface Roster {
  fromDate: string;
  toDate: string;
  dates: string[];
  timezone: string;
  staff: Array<{ membershipId: string; name: string; isBookable: boolean }>;
  shifts: RosterShift[];
  templates: Array<{
    membershipId: string; weekday: Weekday;
    startMin: number; endMin: number; breakMin: number;
  }>;
  /** 按人汇总的本区间工时（分钟） */
  totals: Array<{ membershipId: string; minutes: number }>;
  hasUnpublished: boolean;
}

export async function loadRoster(
  tx: postgres.TransactionSql,
  ctx: CommandContext,
  fromDate: string,
  days: number,
): Promise<Roster> {
  const toDate = addDays(fromDate, days - 1);
  const dates = Array.from({ length: days }, (_, i) => addDays(fromDate, i));

  const [loc] = await tx<{ tz: string }[]>`
    select timezone as tz from locations where id = ${ctx.locationId}`;
  const tz = loc?.tz ?? 'America/New_York';

  const staff = await tx<{ membership_id: string; name: unknown; is_bookable: boolean }[]>`
    select sp.membership_id, sp.display_name as name, sp.is_bookable
    from staff_profiles sp
    join memberships m on m.id = sp.membership_id and m.status = 'active'
    where sp.location_id = ${ctx.locationId}
    order by sp.is_bookable desc, sp.display_name->>'en'`;

  const rows = await tx<{
    membership_id: string; business_date: string;
    start_min: number; end_min: number; break_min: number;
    status: string; off_reason: string | null; note: string | null; from_template: boolean;
  }[]>`
    select membership_id, business_date::text as business_date,
           start_min, end_min, break_min, status, off_reason, note, from_template
    from shifts
    where location_id = ${ctx.locationId}
      and business_date between ${fromDate} and ${toDate}
    order by business_date, start_min`;

  const shifts: RosterShift[] = rows.map((r) => ({
    membershipId: r.membership_id,
    businessDate: r.business_date,
    startMin: r.start_min,
    endMin: r.end_min,
    breakMin: r.break_min,
    status: r.status as RosterShift['status'],
    offReason: r.off_reason,
    note: r.note,
    fromTemplate: r.from_template,
    realMinutes: r.status === 'off' ? 0 : shiftRealMinutes({
      businessDate: r.business_date,
      startMin: r.start_min, endMin: r.end_min, breakMin: r.break_min,
    }, tz),
  }));

  const templates = await tx<{
    membership_id: string; weekday: number;
    start_min: number; end_min: number; break_min: number;
  }[]>`
    select membership_id, weekday, start_min, end_min, break_min
    from shift_templates
    where location_id = ${ctx.locationId} and active = true
    order by membership_id, weekday`;

  const totals = new Map<string, number>();
  for (const s of shifts) {
    totals.set(s.membershipId, (totals.get(s.membershipId) ?? 0) + s.realMinutes);
  }

  return {
    fromDate, toDate, dates, timezone: tz,
    staff: staff.map((s) => ({
      membershipId: s.membership_id,
      name: pickText(s.name, ctx.locale),
      isBookable: s.is_bookable,
    })),
    shifts,
    templates: templates.map((t) => ({
      membershipId: t.membership_id,
      weekday: t.weekday as Weekday,
      startMin: t.start_min, endMin: t.end_min, breakMin: t.break_min,
    })),
    totals: [...totals].map(([membershipId, minutes]) => ({ membershipId, minutes })),
    hasUnpublished: shifts.some((s) => s.status === 'planned'),
  };
}

export { weekdayOf };
