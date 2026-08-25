/**
 * 跨店汇总（批 4）。
 *
 * ## ⭐ 为什么是「一家店一次查询然后在 JS 里加起来」，而不是一条 SQL
 *
 * 一条 `where location_id = any(...)` 的 SQL 看起来更快，但它要求
 * 当前事务能同时看见多家店的数据 —— 而我们所有的 RLS 策略都是按
 * **单个** `app.location_id` 收口的。要让那条 SQL 跑通只有两条路：
 *
 *   · 用 `service_role` 绕过 RLS —— **宪法第 5 条明令禁止**，
 *     而且一旦开这个口子，「跨店汇总」会变成所有越权查询的挡箭牌
 *   · 写一个 SECURITY DEFINER 函数自己做过滤 —— 可行，但那等于
 *     把租户隔离从「数据库强制」降级成「这个函数里的一行 where」，
 *     而那一行以后一定会被人改
 *
 * 所以这里老老实实每家店开一次 `withTenant`：**每一次查询都受
 * 完整的 RLS 约束**，越权在物理上不可能。代价是 N 次往返，
 * 而 N 是「一个老板开几家店」—— 现实里 2 到 5 家。
 *
 * ## 时区
 *
 * ⚠️ **各店按各自的 `business_day_cutoff` 算自己的营业日，然后再相加。**
 * 取 org 一个时区一刀切的话，德州那种横跨两个时区的老板会看到
 * 一家店的「今天」少算了一个上午 —— 而他对不上账时第一反应是系统算错了。
 */

import { withTenant } from '@gf/db';
import type { CommandContext } from '@gf/contracts';

export interface StoreSummary {
  locationId: string;
  name: unknown;
  timezone: string;
  appointments: number;
  newCustomers: number;
  revenueCents: number;
  /** 客单价。没有单据时是 0，不是 null —— 前端少一个分支 */
  avgOrderCents: number;
  /** 取消 + no-show 占比，basis point */
  cancelRateBp: number;
}

export interface OrgSummary {
  from: string;
  to: string;
  stores: StoreSummary[];
  total: Omit<StoreSummary, 'locationId' | 'name' | 'timezone'>;
}

interface Scope {
  orgId: string;
  locationId: string;
  membershipId: string | null;
}

/**
 * @param scopes 调用方已经**按当前用户的 membership** 过滤好的门店列表。
 *   这个函数不自己去查「他有哪些店」—— 那一步在 `listMembershipsForUser`，
 *   它跑在 `withUser` 下，是唯一该负责这件事的地方。
 */
export async function loadOrgSummary(
  scopes: readonly Scope[], from: string, to: string,
): Promise<OrgSummary> {
  const stores: StoreSummary[] = [];

  for (const scope of scopes) {
    const row = await withTenant(scope, async (tx) => {
      const [loc] = await tx<{ name: unknown; tz: string }[]>`
        select name, timezone as tz from locations where id = ${scope.locationId}`;
      if (!loc) return null;

      /*
       * ⚠️ 按 `business_date` 筛，不按 `starts_at` 筛。
       * 凌晨两点那一单属于**前一个**营业日（business_day_cutoff），
       * 按时间戳筛会把它算进第二天 —— 而老板的账是按营业日结的。
       */
      const [appt] = await tx<{ total: number; cancelled: number }[]>`
        select count(*)::int as total,
               count(*) filter (where status in ('cancelled','no_show'))::int as cancelled
        from appointments
        where location_id = ${scope.locationId}
          and business_date >= ${from} and business_date <= ${to}`;

      const [cust] = await tx<{ n: number }[]>`
        select count(*)::int as n from customers
        where primary_location_id = ${scope.locationId}
          and created_at >= ${from}::date and created_at < (${to}::date + 1)`;

      /*
       * 营收取**已结的单**（tickets），不取预约 —— 预约只是意向。
       * 作废的单排除掉：它在账上是冲销的，不是收入（宪法第 9 条）。
       */
      // ⚠️ 列名是 total_cents（含税含小费的实收），tickets 上没有 net_cents
      const [money] = await tx<{ gross: number; n: number }[]>`
        select coalesce(sum(total_cents), 0)::int as gross, count(*)::int as n
        from tickets
        where location_id = ${scope.locationId}
          and business_date >= ${from} and business_date <= ${to}
          and status = 'closed'`;

      const total = appt?.total ?? 0;
      const tickets = money?.n ?? 0;
      return {
        locationId: scope.locationId,
        name: loc.name,
        timezone: loc.tz,
        appointments: total,
        newCustomers: cust?.n ?? 0,
        revenueCents: money?.gross ?? 0,
        avgOrderCents: tickets > 0 ? Math.round((money?.gross ?? 0) / tickets) : 0,
        cancelRateBp: total > 0 ? Math.round(((appt?.cancelled ?? 0) / total) * 10000) : 0,
      } satisfies StoreSummary;
    });
    if (row) stores.push(row);
  }

  const sum = (pick: (s: StoreSummary) => number) => stores.reduce((n, s) => n + pick(s), 0);
  const appointments = sum((s) => s.appointments);
  const revenueCents = sum((s) => s.revenueCents);

  /*
   * ⚠️ 合计的客单价和取消率**要重算，不能把各店的平均值再平均**。
   * 一家做了 100 单、一家做了 2 单，把两个客单价一平均，
   * 那 2 单的店会和 100 单的店一样重 —— 数字看着合理，其实是错的。
   */
  const ticketishTotal = stores.reduce(
    (n, s) => n + (s.avgOrderCents > 0 ? Math.round(s.revenueCents / s.avgOrderCents) : 0), 0);
  const cancelled = stores.reduce(
    (n, s) => n + Math.round((s.cancelRateBp / 10000) * s.appointments), 0);

  return {
    from, to, stores,
    total: {
      appointments,
      newCustomers: sum((s) => s.newCustomers),
      revenueCents,
      avgOrderCents: ticketishTotal > 0 ? Math.round(revenueCents / ticketishTotal) : 0,
      cancelRateBp: appointments > 0 ? Math.round((cancelled / appointments) * 10000) : 0,
    },
  };
}
