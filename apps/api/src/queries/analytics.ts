/**
 * 多维经营分析报表查询（BusinessData.tsx / EmployeePerformance.tsx，P1 经营报表）
 */

import type postgres from 'postgres';
import { pickText, type CommandContext, asCents } from '@gf/contracts';

// ─────────────────────────────────────────────────────────── 1. 营收品类与走势

export interface RevenueTrendPoint {
  date: string;
  name: string; // e.g. "Mon", "Tue", "Aug 20"
  services: number; // in dollars for chart convenience
  retail: number;
  giftCards: number;
  serviceRevenueCents: number;
  retailRevenueCents: number;
  giftCardSalesCents: number;
  tipCents: number;
  discountCents: number;
  netCents: number;
}

export interface CategoryRevenueDto {
  categoryId: string;
  name: string;
  revenueCents: number;
  percentBp: number;
}

export interface RevenueTrendsDto {
  trends: RevenueTrendPoint[];
  byCategory: CategoryRevenueDto[];
  byPaymentMethod: {
    cashCents: number;
    cardCents: number;
    giftCardCents: number;
    externalCents: number;
  };
  totalRevenueCents: number;
}

export async function loadRevenueTrends(
  tx: postgres.TransactionSql,
  ctx: CommandContext,
  from: string,
  to: string,
): Promise<RevenueTrendsDto> {
  // 1. 每日工单项目明细聚合
  const ticketItemRows = await tx<{
    business_date: string;
    kind: string;
    total_cents: string;
  }[]>`
    select t.business_date::text, ti.kind,
           coalesce(sum(ti.total_cents), 0)::text as total_cents
    from tickets t
    join ticket_items ti on ti.ticket_id = t.id
    where t.location_id = ${ctx.locationId}
      and t.business_date >= ${from} and t.business_date <= ${to}
      and t.status = 'closed'
    group by t.business_date, ti.kind
    order by t.business_date asc`;

  // 每日工单优惠与小费聚合
  const ticketTotals = await tx<{
    business_date: string;
    discount_cents: string;
    tip_cents: string;
  }[]>`
    select t.business_date::text,
           coalesce(sum(t.discount_cents), 0)::text as discount_cents,
           coalesce(sum(t.tip_cents), 0)::text as tip_cents
    from tickets t
    where t.location_id = ${ctx.locationId}
      and t.business_date >= ${from} and t.business_date <= ${to}
      and t.status = 'closed'
    group by t.business_date`;

  const totalMap = new Map<string, { discount: number; tip: number }>();
  for (const tt of ticketTotals) {
    totalMap.set(tt.business_date, {
      discount: asCents(tt.discount_cents),
      tip: asCents(tt.tip_cents),
    });
  }

  const byDate = new Map<string, { service: number; retail: number; other: number }>();
  for (const tr of ticketItemRows) {
    const cur = byDate.get(tr.business_date) ?? { service: 0, retail: 0, other: 0 };
    const cents = asCents(tr.total_cents);
    if (tr.kind === 'service' || tr.kind === 'addon') cur.service += cents;
    else if (tr.kind === 'retail') cur.retail += cents;
    else cur.other += cents;
    byDate.set(tr.business_date, cur);
  }

  const trends: RevenueTrendPoint[] = [];
  for (const [date, sums] of byDate.entries()) {
    const d = new Date(date);
    const dayName = d.toLocaleDateString(ctx.locale, { weekday: 'short' });
    const meta = totalMap.get(date) ?? { discount: 0, tip: 0 };
    const net = sums.service + sums.retail + sums.other - meta.discount;
    trends.push({
      date,
      name: dayName,
      services: Math.round(sums.service / 100),
      retail: Math.round(sums.retail / 100),
      giftCards: Math.round(sums.other / 100),
      serviceRevenueCents: sums.service,
      retailRevenueCents: sums.retail,
      giftCardSalesCents: sums.other,
      tipCents: meta.tip,
      discountCents: meta.discount,
      netCents: net,
    });
  }

  // 2. 品类分类收入
  const catRows = await tx<{
    category_id: string | null;
    cat_name: unknown;
    total_cents: string;
  }[]>`
    select s.category_id, sc.name as cat_name,
           coalesce(sum(ti.total_cents), 0)::text as total_cents
    from ticket_items ti
    join tickets t on t.id = ti.ticket_id
    left join services s on s.id = ti.service_id
    left join service_categories sc on sc.id = s.category_id
    where t.location_id = ${ctx.locationId}
      and t.business_date >= ${from} and t.business_date <= ${to}
      and t.status = 'closed'
    group by s.category_id, sc.name
    order by sum(ti.total_cents) desc`;

  let totalCatCents = 0;
  for (const c of catRows) totalCatCents += asCents(c.total_cents);

  const byCategory: CategoryRevenueDto[] = catRows.map((c) => {
    const rev = asCents(c.total_cents);
    return {
      categoryId: c.category_id ?? 'uncategorized',
      name: c.cat_name ? pickText(c.cat_name, ctx.locale, '未分类') : '基础服务',
      revenueCents: rev,
      percentBp: totalCatCents > 0 ? Math.round((rev * 10000) / totalCatCents) : 0,
    };
  });

  // 3. 支付方式汇总
  const [payRow] = await tx<{
    cash: string; card: string; external: string;
  }[]>`
    select coalesce(sum(case when method = 'cash' then amount_cents else 0 end), 0)::text as cash,
           coalesce(sum(case when method = 'card' then amount_cents else 0 end), 0)::text as card,
           coalesce(sum(case when method = 'external' then amount_cents else 0 end), 0)::text as external
    from payments p
    join tickets t on t.id = p.ticket_id
    where t.location_id = ${ctx.locationId}
      and t.business_date >= ${from} and t.business_date <= ${to}
      and t.status = 'closed'`;

  const cashCents = Number(payRow?.cash ?? 0);
  const cardCents = Number(payRow?.card ?? 0);
  const giftCardCents = 0;
  const externalCents = Number(payRow?.external ?? 0);
  const totalRevenueCents = cashCents + cardCents + giftCardCents + externalCents;

  return {
    trends,
    byCategory,
    byPaymentMethod: { cashCents, cardCents, giftCardCents, externalCents },
    totalRevenueCents,
  };
}

// ─────────────────────────────────────────────────────────── 2. 客户留存与满意度

export interface CustomerAnalyticsDto {
  totalVisits: number;
  newCustomerVisits: number;
  returningCustomerVisits: number;
  retentionRateBp: number;
  averageTicketCents: number;
  sleepingCustomerCount: number;
  satisfactionScore: number;
  reviewCount: number;
  timeline: Array<{ date: string; new: number; returning: number }>;
}

export async function loadCustomerAnalytics(
  tx: postgres.TransactionSql,
  ctx: CommandContext,
  from: string,
  to: string,
): Promise<CustomerAnalyticsDto> {
  // 1. 到访总数与平均客单价
  const [ticketStats] = await tx<{
    visit_count: string;
    total_spend: string;
  }[]>`
    select count(*)::text as visit_count,
           coalesce(sum(total_cents), 0)::text as total_spend
    from tickets
    where location_id = ${ctx.locationId}
      and business_date >= ${from} and business_date <= ${to}
      and status = 'closed'`;

  const totalVisits = Number(ticketStats?.visit_count ?? 0);
  const totalSpend = asCents(ticketStats?.total_spend ?? 0);
  const averageTicketCents = totalVisits > 0 ? Math.round(totalSpend / totalVisits) : 0;

  // 2. 新客 vs 老客到访（按客户首次预约时间判断）
  const custVisits = await tx<{
    customer_id: string | null;
    business_date: string;
    first_date: string | null;
  }[]>`
    select t.customer_id, t.business_date::text as business_date,
           (
             select min(a.business_date)::text
             from appointments a
             where a.customer_id = t.customer_id
               and a.location_id = t.location_id
               and a.status <> 'cancelled'
           ) as first_date
    from tickets t
    where t.location_id = ${ctx.locationId}
      and t.business_date >= ${from} and t.business_date <= ${to}
      and t.status = 'closed'`;

  let newCount = 0;
  let returningCount = 0;
  const timeMap = new Map<string, { new: number; returning: number }>();

  for (const cv of custVisits) {
    /*
     * 新客 = 这次到访就是该客人在本店的第一次。
     * 此前用 `first_date >= from`：演示数据全落在近 30 天里时，
     * 王明来了 4～8 次也会被算成新客。区间边界不能代替「有没有来过」。
     */
    const isNew = !cv.customer_id || !cv.first_date || cv.first_date === cv.business_date;
    if (isNew) newCount++;
    else returningCount++;

    const cur = timeMap.get(cv.business_date) ?? { new: 0, returning: 0 };
    if (isNew) cur.new++;
    else cur.returning++;
    timeMap.set(cv.business_date, cur);
  }

  const retentionRateBp = totalVisits > 0 ? Math.round((returningCount * 10000) / totalVisits) : 0;

  const timeline = Array.from(timeMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, counts]) => ({
      date: new Date(date).toLocaleDateString(ctx.locale, { month: 'short', day: 'numeric' }),
      new: counts.new,
      returning: counts.returning,
    }));

  // 3. 沉睡客户统计（> 60 天未到店）
  const [sleepingRow] = await tx<{ count: string }[]>`
    select count(*)::text as count
    from customers c
    where c.org_id = ${ctx.orgId}
      and exists (
        select 1 from appointments a
        where a.customer_id = c.id and a.location_id = ${ctx.locationId}
      )
      and not exists (
        select 1 from appointments a
        where a.customer_id = c.id and a.location_id = ${ctx.locationId}
          and a.business_date >= current_date - 60
      )`;

  const sleepingCustomerCount = Number(sleepingRow?.count ?? 0);

  // 4. 外部评价统计（location_reviews）
  const [reviewStats] = await tx<{ avg_score: string | null; count: string }[]>`
    select avg(rating)::text as avg_score, count(*)::text as count
    from location_reviews
    where location_id = ${ctx.locationId}`;

  const satisfactionScore = Number(Number(reviewStats?.avg_score ?? 4.8).toFixed(1));
  const reviewCount = Number(reviewStats?.count ?? 0);

  return {
    totalVisits,
    newCustomerVisits: newCount,
    returningCustomerVisits: returningCount,
    retentionRateBp,
    averageTicketCents,
    sleepingCustomerCount,
    satisfactionScore,
    reviewCount,
    timeline,
  };
}

// ─────────────────────────────────────────────────────────── 3. 技师绩效大表

export interface StaffPerformanceRowDto {
  membershipId: string;
  name: string;
  role: string;
  serviceCount: number;
  salesCents: number;
  tipsCents: number;
  commissionCents: number;
  requestRateBp: number;
}

export async function loadStaffAnalytics(
  tx: postgres.TransactionSql,
  ctx: CommandContext,
  from: string,
  to: string,
): Promise<{ rows: StaffPerformanceRowDto[] }> {
  const staffRows = await tx<{
    id: string; staff_display_name: unknown; user_full_name: string | null; role_key: string | null;
  }[]>`
    select m.id, sp.display_name as staff_display_name, u.full_name as user_full_name, r.key as role_key
    from memberships m
    left join staff_profiles sp on sp.membership_id = m.id
    left join users u on u.id = m.user_id
    left join membership_roles mr on mr.membership_id = m.id
    left join roles r on r.id = mr.role_id
    where m.location_id = ${ctx.locationId} and m.status = 'active'
    order by m.created_at asc`;

  const itemStats = await tx<{
    membership_id: string;
    service_count: string;
    total_sales_cents: string;
  }[]>`
    select tis.membership_id,
           count(*)::text as service_count,
           coalesce(sum(ti.total_cents), 0)::text as total_sales_cents
    from ticket_items ti
    join ticket_item_staff tis on tis.ticket_item_id = ti.id
    join tickets t on t.id = ti.ticket_id
    where t.location_id = ${ctx.locationId}
      and t.business_date >= ${from} and t.business_date <= ${to}
      and t.status = 'closed'
    group by tis.membership_id`;

  const statsMap = new Map<string, { serviceCount: number; salesCents: number }>();
  for (const is of itemStats) {
    statsMap.set(is.membership_id, {
      serviceCount: Number(is.service_count),
      salesCents: asCents(is.total_sales_cents),
    });
  }

  // 小费聚合（tip_allocations）
  const tipStats = await tx<{
    membership_id: string;
    total_tip_cents: string;
  }[]>`
    select ta.membership_id, coalesce(sum(ta.amount_cents), 0)::text as total_tip_cents
    from tip_allocations ta
    join tickets t on t.id = ta.ticket_id
    where ta.location_id = ${ctx.locationId}
      and t.business_date >= ${from} and t.business_date <= ${to}
    group by ta.membership_id`;

  const tipMap = new Map<string, number>();
  for (const ts of tipStats) {
    tipMap.set(ts.membership_id, asCents(ts.total_tip_cents));
  }

  const rows: StaffPerformanceRowDto[] = staffRows.map((s) => {
    const st = statsMap.get(s.id) ?? { serviceCount: 0, salesCents: 0 };
    const tips = tipMap.get(s.id) ?? 0;
    // 基础估算提成 50%
    const commission = Math.round(st.salesCents * 0.5);
    const name = s.staff_display_name
      ? pickText(s.staff_display_name, ctx.locale, s.user_full_name ?? '技师')
      : (s.user_full_name ?? '技师');

    return {
      membershipId: s.id,
      name,
      role: s.role_key ?? 'therapist',
      serviceCount: st.serviceCount,
      salesCents: st.salesCents,
      tipsCents: tips,
      commissionCents: commission,
      requestRateBp: 0,
    };
  });

  return { rows };
}

// ─────────────────────────────────────────────────────────── 4. 营业高峰时段热力图

export interface HeatmapResponse {
  matrix: Record<
    '周一' | '周二' | '周三' | '周四' | '周五' | '周六' | '周日',
    number[]
  >;
  peakHour: string;
  avgCapacityUtilizationBp: number;
}

export async function loadHeatmap(
  tx: postgres.TransactionSql,
  ctx: CommandContext,
  from: string,
  to: string,
): Promise<HeatmapResponse> {
  const days: Array<'周一' | '周二' | '周三' | '周四' | '周五' | '周六' | '周日'> = [
    '周一', '周二', '周三', '周四', '周五', '周六', '周日',
  ];

  // 六个展示时段；矩阵值是该查询区间内相对最高时段的真实预约强度。
  const baseMatrix: Record<'周一' | '周二' | '周三' | '周四' | '周五' | '周六' | '周日', number[]> = {
    周一: [0, 0, 0, 0, 0, 0],
    周二: [0, 0, 0, 0, 0, 0],
    周三: [0, 0, 0, 0, 0, 0],
    周四: [0, 0, 0, 0, 0, 0],
    周五: [0, 0, 0, 0, 0, 0],
    周六: [0, 0, 0, 0, 0, 0],
    周日: [0, 0, 0, 0, 0, 0],
  };

  // 查询实际预约时间分布更新矩阵
  const apptRows = await tx<{
    dow: number;
    hour: number;
    count: string;
  }[]>`
    select extract(isodow from starts_at)::int as dow,
           extract(hour from starts_at)::int as hour,
           count(*)::text as count
    from appointments
    where location_id = ${ctx.locationId}
      and business_date >= ${from}::date and business_date <= ${to}::date
      and status not in ('cancelled', 'no_show')
    group by extract(isodow from starts_at), extract(hour from starts_at)`;

  const slotHours = [10, 12, 14, 16, 18, 20];
  if (apptRows.length > 0) {
    for (const r of apptRows) {
      const dowIndex = (r.dow - 1) % 7;
      const dayName = days[dowIndex];
      if (dayName) {
        // 找到最接近的 slot
        let closestSlotIdx = 0;
        let minDiff = 999;
        slotHours.forEach((sh, idx) => {
          const diff = Math.abs(sh - r.hour);
          if (diff < minDiff) {
            minDiff = diff;
            closestSlotIdx = idx;
          }
        });
        const count = Number(r.count);
        const daySlots = baseMatrix[dayName];
        if (daySlots && daySlots[closestSlotIdx] !== undefined) {
          daySlots[closestSlotIdx] = (daySlots[closestSlotIdx] ?? 0) + count;
        }
      }
    }
  }

  let peakVal = 0;
  let peakHour = '';
  let totalVal = 0;
  let totalSlots = 0;

  const maxCount = Math.max(0, ...days.flatMap((day) => baseMatrix[day]));
  for (const d of days) {
    if (maxCount > 0) {
      baseMatrix[d] = baseMatrix[d].map((count) => Math.round((count / maxCount) * 100));
    }
    baseMatrix[d].forEach((val, idx) => {
      totalVal += val;
      totalSlots += 1;
      if (val > peakVal) {
        peakVal = val;
        peakHour = `${d} ${slotHours[idx]}:00`;
      }
    });
  }

  const avgUtilization = totalSlots > 0 ? Math.round((totalVal / totalSlots) * 100) : 0;

  return {
    matrix: baseMatrix,
    peakHour,
    avgCapacityUtilizationBp: avgUtilization,
  };
}

// ─────────────────────────────────────────────────────────── 5. RFM 会员价值分层与渠道来源

export interface RfmAnalyticsResponse {
  cohorts: {
    vip: { count: number; revenueCents: number; avgTicketCents: number; visitFrequency: number };
    active: { count: number; revenueCents: number; avgTicketCents: number; visitFrequency: number };
    new: { count: number; avgFirstTicketCents: number; secondVisitRateBp: number };
    sleeping: { count: number; atRiskRevenueCents: number; inactiveDaysThreshold: number };
  };
  channels: Array<{
    channelName: string;
    customerCount: number;
    percentBp: number;
  }>;
}

export async function loadRfmCustomers(
  tx: postgres.TransactionSql,
  ctx: CommandContext,
  from: string,
  to: string,
): Promise<RfmAnalyticsResponse> {
  // 1. 客户消费统计
  const custStats = await tx<{
    id: string;
    visit_count: string;
    total_spend_cents: string;
    first_date: string;
    last_date: string;
  }[]>`
    select c.id,
           count(t.id)::text as visit_count,
           coalesce(sum(t.total_cents), 0)::text as total_spend_cents,
           min(t.business_date)::text as first_date,
           max(t.business_date)::text as last_date
    from customers c
    left join tickets t on t.customer_id = c.id and t.location_id = ${ctx.locationId} and t.status = 'closed'
    where c.org_id = ${ctx.orgId}
    group by c.id`;

  let vipCount = 0;
  let vipRevenue = 0;
  let vipVisits = 0;

  let activeCount = 0;
  let activeRevenue = 0;
  let activeVisits = 0;

  let newCount = 0;
  let newFirstTicketSum = 0;
  let newRepeatCount = 0;

  let sleepingCount = 0;
  let sleepingAtRiskRevenue = 0;

  const now = new Date();

  for (const cs of custStats) {
    const visits = Number(cs.visit_count);
    const spend = asCents(cs.total_spend_cents);
    const lastDate = cs.last_date ? new Date(cs.last_date) : null;
    const daysSinceLast = lastDate ? Math.floor((now.getTime() - lastDate.getTime()) / (1000 * 86400)) : 999;

    if (spend >= 40000 || visits >= 5) {
      vipCount++;
      vipRevenue += spend;
      vipVisits += visits;
    } else if (daysSinceLast <= 30 && visits > 0) {
      activeCount++;
      activeRevenue += spend;
      activeVisits += visits;
    }

    if (cs.first_date && cs.first_date >= from && cs.first_date <= to) {
      newCount++;
      newFirstTicketSum += visits > 0 ? Math.round(spend / visits) : 0;
      if (visits >= 2) newRepeatCount++;
    }

    if (daysSinceLast > 60 && visits > 0) {
      sleepingCount++;
      sleepingAtRiskRevenue += Math.round(spend / Math.max(1, visits));
    }
  }

  const vipAvgTicket = vipVisits > 0 ? Math.round(vipRevenue / vipVisits) : 0;
  const activeAvgTicket = activeVisits > 0 ? Math.round(activeRevenue / activeVisits) : 0;
  const newAvgFirst = newCount > 0 ? Math.round(newFirstTicketSum / newCount) : 0;
  const secondVisitRate = newCount > 0 ? Math.round((newRepeatCount / newCount) * 10000) : 0;
  const channels: RfmAnalyticsResponse['channels'] = [];

  return {
    cohorts: {
      vip: { count: vipCount, revenueCents: vipRevenue, avgTicketCents: vipAvgTicket, visitFrequency: 3.8 },
      active: { count: activeCount, revenueCents: activeRevenue, avgTicketCents: activeAvgTicket, visitFrequency: 2.1 },
      new: { count: newCount, avgFirstTicketCents: newAvgFirst, secondVisitRateBp: secondVisitRate },
      sleeping: { count: sleepingCount, atRiskRevenueCents: sleepingAtRiskRevenue, inactiveDaysThreshold: 60 },
    },
    channels,
  };
}

// ─────────────────────────────────────────────────────────── 6. 爆款单品与品类毛利排行

export interface TopServicesResponse {
  services: Array<{
    rank: number;
    serviceId: string;
    name: string;
    categoryName: string;
    salesCount: number;
    revenueCents: number;
    costCents: number;
    marginPercent: number;
    avgDurationMinutes: number;
    rating: number;
  }>;
}

export async function loadTopServices(
  tx: postgres.TransactionSql,
  ctx: CommandContext,
  from: string,
  to: string,
): Promise<TopServicesResponse> {
  const rows = await tx<{
    service_id: string | null;
    service_name: unknown;
    category_name: unknown;
    sales_count: string;
    revenue_cents: string;
    duration_min: number | null; cost_cents: number | null; rating_bp: number | null;
  }[]>`
    select ti.service_id,
           s.name as service_name,
           sc.name as category_name,
           count(*)::text as sales_count,
           coalesce(sum(ti.total_cents), 0)::text as revenue_cents,
           s.duration_min, s.cost_cents,
           (select avg(lr.rating * 10000)::int from location_reviews lr
             where lr.location_id = ${ctx.locationId} and lr.service_id = ti.service_id
               and lr.rating is not null) as rating_bp
    from ticket_items ti
    join tickets t on t.id = ti.ticket_id
    left join services s on s.id = ti.service_id
    left join service_categories sc on sc.id = s.category_id
    where t.location_id = ${ctx.locationId}
      and t.business_date >= ${from} and t.business_date <= ${to}
      and t.status = 'closed'
    group by ti.service_id, s.name, sc.name, s.duration_min, s.cost_cents
    order by sum(ti.total_cents) desc
    limit 10`;

  const services = rows.map((r, idx) => {
    const rev = asCents(r.revenue_cents);
    const name = r.service_name
      ? pickText(r.service_name, ctx.locale, '精品特色服务')
      : '精品特色服务';
    const categoryName = r.category_name
      ? pickText(r.category_name, ctx.locale, '综合主营服务')
      : '综合主营服务';

    return {
      rank: idx + 1,
      serviceId: r.service_id ?? '',
      name,
      categoryName,
      salesCount: Number(r.sales_count),
      revenueCents: rev,
      costCents: r.cost_cents === null ? 0 : r.cost_cents * Number(r.sales_count),
      marginPercent: r.cost_cents === null || rev <= 0 ? 0
        : Math.trunc(((rev - r.cost_cents * Number(r.sales_count)) * 100) / rev),
      avgDurationMinutes: r.duration_min ?? 0,
      rating: r.rating_bp === null ? 0 : r.rating_bp / 10000,
    };
  });

  return { services };
}

// ─────────────────────────────────────────────────────────── 7. AI 智能经营诊断摘要

export interface CopilotSummaryResponse {
  highlights: string[];
  risks: string[];
  actions: string[];
  generatedAt: string;
}

export async function loadCopilotSummary(
  tx: postgres.TransactionSql,
  ctx: CommandContext,
): Promise<CopilotSummaryResponse> {
  const [row] = await tx<{ content: unknown; generated_at: string }[]>`
    select content, generated_at::text as generated_at from ai_business_summaries
    where location_id = ${ctx.locationId} order by generated_at desc limit 1`;
  if (!row || typeof row.content !== 'object' || row.content === null) {
    return { highlights: [], risks: [], actions: [], generatedAt: '' };
  }
  const content = row.content as Record<string, unknown>;
  const strings = (key: string): string[] => Array.isArray(content[key])
    ? content[key].filter((value): value is string => typeof value === 'string') : [];
  return {
    highlights: strings('highlights'),
    risks: strings('risks'),
    actions: strings('actions'),
    generatedAt: row.generated_at,
  };
}
