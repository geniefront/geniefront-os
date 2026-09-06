/**
 * 预约日历取数（副驾易变上下文段）
 *
 * 过去 7 天 + 未来 30 天的每一条预约，按营业日分组，每条带 appointmentId。
 *
 * ## 为什么一次全下发
 *
 * 上一版让模型按需调 `search_appointments(businessDate)` 查，一次只能查一天。
 * 前台一句「这周还有哪天能插进来一个 90 分钟的」就要连查七天，七次往返。
 * 而这些数据一次查完只是一条 SQL。
 *
 * ## 为什么每条都带 appointmentId
 *
 * 改期、取消、签到都要 ID。实测账单里 input 几乎免费、output 才是大头，
 * 多几万个 UUID 的 input 远比多一次工具往返便宜。
 *
 * ## 这一段必须每轮重建
 *
 * 门店档案可以缓存，日历不行 —— 差一轮就可能撞单。
 *
 * 格式化在 `@gf/ai` 的 `formatBookingCalendar`（纯函数、有测试）。这里只查。
 */

import type postgres from 'postgres';
import { parseTs } from '@gf/db';
import { pickText, type CommandContext } from '@gf/contracts';
import type { BookingCalendar, CalendarDay, CalendarItem } from '@gf/ai';

/** 往前看几天。够回答「上次做的什么 / 上周谁来过」就行 */
export const CALENDAR_DAYS_BACK = 7;
/** 往后看几天。覆盖绝大多数排期与改期场景 */
export const CALENDAR_DAYS_FORWARD = 30;

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** `2026-09-06` + n 天，纯日期算术，不碰时区 */
function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

function weekdayOf(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return WEEKDAY_LABELS[new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay()] ?? 'Mon';
}

/** 分钟数 → 门店墙上时间 HH:MM。跨午夜的班次（endMin > 1440）取模显示 */
function minToClock(min: number): string {
  const m = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

export async function loadBookingCalendar(
  tx: postgres.TransactionSql,
  ctx: CommandContext,
  todayBusinessDate: string,
  timezone: string,
): Promise<BookingCalendar> {
  const fromDate = addDays(todayBusinessDate, -CALENDAR_DAYS_BACK);
  const toDate = addDays(todayBusinessDate, CALENDAR_DAYS_FORWARD);

  // ── 预约明细 ──────────────────────────────────────────────────────────────
  //
  // 已取消的单不下发：它们对「这个时段有没有空」没有影响，
  // 而模型看到一条 cancelled 记录很容易当成还在的单去改期。
  const rows = await tx<{
    appointment_id: string;
    business_date: string;
    starts_at: string | Date;
    duration_min: number;
    customer_name: string | null;
    walk_in_name: string | null;
    service_name: unknown;
    staff_name: unknown;
    status: string;
    is_request: boolean;
    room_name: string | null;
  }[]>`
    select ai.appointment_id, a.business_date::text as business_date,
           ai.starts_at, ai.duration_min,
           c.display_name as customer_name, a.walk_in_name,
           s.name as service_name, sp.display_name as staff_name,
           ai.status, ai.is_request, r.name as room_name
    from appointment_items ai
    join appointments a on a.id = ai.appointment_id
    join services s on s.id = ai.service_id
    left join staff_profiles sp on sp.membership_id = ai.membership_id
    left join customers c on c.id = a.customer_id
    left join resources r on r.id = ai.resource_id
    where ai.location_id = ${ctx.locationId}
      and a.business_date between ${fromDate} and ${toDate}
      and ai.status <> 'cancelled'
    order by a.business_date, ai.starts_at, ai.seq`;

  // ── 排班（含休假）──────────────────────────────────────────────────────────
  const shiftRows = await tx<{
    business_date: string;
    start_min: number;
    end_min: number;
    status: string;
    staff_name: unknown;
  }[]>`
    select sh.business_date::text as business_date,
           sh.start_min, sh.end_min, sh.status,
           sp.display_name as staff_name
    from shifts sh
    join staff_profiles sp on sp.membership_id = sh.membership_id
      and sp.location_id = sh.location_id
    where sh.location_id = ${ctx.locationId}
      and sh.business_date between ${fromDate} and ${toDate}
    order by sh.business_date, sh.start_min, sp.display_name->>'en'`;

  const itemsByDate = new Map<string, CalendarItem[]>();
  for (const r of rows) {
    const list = itemsByDate.get(r.business_date) ?? [];
    list.push({
      appointmentId: r.appointment_id,
      startsAt: new Intl.DateTimeFormat('en-GB', {
        timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false,
      }).format(parseTs(r.starts_at)),
      customerName: r.customer_name ?? r.walk_in_name ?? '散客',
      serviceName: pickText(r.service_name, ctx.locale),
      durationMin: r.duration_min,
      staffName: r.staff_name ? pickText(r.staff_name, ctx.locale) : null,
      status: r.status,
      ...(r.is_request ? { isRequest: true } : {}),
      ...(r.room_name ? { roomName: r.room_name } : {}),
    });
    itemsByDate.set(r.business_date, list);
  }

  const shiftsByDate = new Map<string, string[]>();
  const offByDate = new Map<string, string[]>();
  for (const s of shiftRows) {
    const name = pickText(s.staff_name, ctx.locale);
    if (s.status === 'off') {
      const list = offByDate.get(s.business_date) ?? [];
      list.push(name);
      offByDate.set(s.business_date, list);
    } else {
      const list = shiftsByDate.get(s.business_date) ?? [];
      list.push(`${name} ${minToClock(s.start_min)}-${minToClock(s.end_min)}`);
      shiftsByDate.set(s.business_date, list);
    }
  }

  const days: CalendarDay[] = [];
  for (let i = -CALENDAR_DAYS_BACK; i <= CALENDAR_DAYS_FORWARD; i++) {
    const date = addDays(todayBusinessDate, i);
    days.push({
      businessDate: date,
      weekday: weekdayOf(date),
      items: itemsByDate.get(date) ?? [],
      shifts: shiftsByDate.get(date) ?? [],
      off: offByDate.get(date) ?? [],
    });
  }

  return { fromDate, toDate, todayDate: todayBusinessDate, days };
}
