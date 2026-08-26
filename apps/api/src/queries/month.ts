/**
 * 区间概览 —— 月视图那张日历吃的就是这一份。
 *
 * ## 为什么不是「循环调 31 次 `loadDay`」
 *
 * `loadDay` 一天要跑四条查询，而且每天都把**全店的员工、项目、房间**
 * 原样带一遍。铺满一个月是 124 次查询 + 三十份重复的项目表，
 * 门店那点网络扛不住，而日历格子上一个字都用不到它们。
 *
 * 所以这里只回**每天一行的密度信息**：开不开门、几点到几点、几条单、
 * 几个人上班、日结了没有。点进某一天再调 `/v1/desk/day` 拿细节。
 *
 * ## 为什么营业时间在这里算而不是让前端算
 *
 * 前端要画「周日关门」这一格，就得自己解析 `business_hours` 那个 jsonb、
 * 自己处理跨午夜、自己处理「没配过」和「不营业」的区别 ——
 * 那是 `@gf/scheduling/business-hours` 已经解决过一遍的事（sql/0046）。
 * 抄第二遍的结果是日历上关门的日子和建单闸门认定的不是同一批。
 */

import type postgres from 'postgres';
import { dayWindow, hoursConfigured, type WeeklyHours } from '@gf/scheduling';

export interface MonthDay {
  businessDate: string;
  /**
   * 那天开不开门。
   *
   * ⚠️ `business_hours` 一个键都没配的新店，**每天都是 `true`** ——
   * 「还没配」不是「不营业」（和建单闸门同一个口径，sql/0046）。
   * 那种店的 `openMin` / `closeMin` 是 null，日历照常能画，只是没有时间轴。
   */
  isOpen: boolean;
  /** 营业日墙上分钟。关门那天是 null；跨午夜的店 closeMin 会 > 1440 */
  openMin: number | null;
  closeMin: number | null;
  /** 预约条数（父行，不是 item） */
  appointments: number;
  /** 项目条数。一单两个项目就是 2 —— 日历上的密度看这个更准 */
  items: number;
  /** 当天有 published 班次的人数 */
  staffOnDuty: number;
  /** 日结状态：null = 还没开始，其余见 day_closes.status */
  daycloseStatus: string | null;
}

export interface MonthRange {
  from: string;
  to: string;
  timezone: string;
  days: MonthDay[];
}

/** 从 from 到 to（含两端）的每一天。用 UTC 做算术，避开本机时区 */
function eachDate(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

export async function loadMonth(
  tx: postgres.TransactionSql,
  locationId: string,
  from: string,
  to: string,
): Promise<MonthRange> {
  const [loc] = await tx<{ timezone: string; hours: WeeklyHours }[]>`
    select timezone, business_hours as hours from locations where id = ${locationId}`;

  /*
   * 三条聚合查询，**不是每天三条**。
   *
   * 取消的单不算进密度：日历上一格显示「8」而点进去只有 3 条，
   * 前台会以为系统丢单了。
   */
  const apptRows = await tx<{ d: string; appointments: number; items: number }[]>`
    select a.business_date::text as d,
           count(distinct a.id)::int as appointments,
           count(ai.id)::int as items
    from appointments a
    join appointment_items ai
      on ai.appointment_id = a.id and ai.status <> 'cancelled'
    where a.location_id = ${locationId}
      and a.business_date between ${from} and ${to}
      and a.status <> 'cancelled'
    group by a.business_date`;

  // 只数 published 的班。planned 还没发给技师，画在日历上等于替他答应了
  const shiftRows = await tx<{ d: string; n: number }[]>`
    select business_date::text as d, count(distinct membership_id)::int as n
    from shifts
    where location_id = ${locationId}
      and business_date between ${from} and ${to}
      and status = 'published'
    group by business_date`;

  const closeRows = await tx<{ d: string; status: string }[]>`
    select business_date::text as d, status from day_closes
    where location_id = ${locationId} and business_date between ${from} and ${to}`;

  const byAppt = new Map(apptRows.map((r) => [r.d, r]));
  const byShift = new Map(shiftRows.map((r) => [r.d, r.n]));
  const byClose = new Map(closeRows.map((r) => [r.d, r.status]));

  // 没配营业时间的新店：每天都算开门，只是没有时间轴（见 MonthDay.isOpen）
  const configured = hoursConfigured(loc?.hours);

  return {
    from,
    to,
    timezone: loc?.timezone ?? 'America/New_York',
    days: eachDate(from, to).map((d) => {
      const win = configured ? dayWindow(d, loc!.hours) : null;
      const a = byAppt.get(d);
      return {
        businessDate: d,
        isOpen: configured ? win !== null : true,
        openMin: win?.openMin ?? null,
        closeMin: win?.closeMin ?? null,
        appointments: a?.appointments ?? 0,
        items: a?.items ?? 0,
        staffOnDuty: byShift.get(d) ?? 0,
        daycloseStatus: byClose.get(d) ?? null,
      };
    }),
  };
}
