/**
 * 钱的只读查询：技师当日收入、日结页快照、营业报表。
 *
 * 三个接口共用一条纪律：**作废的单一行都不进**（宪法第 9 条）。
 * 冲销过的 earnings / tip_allocations 同理 —— 它们留在库里是为了可追溯，
 * 不是为了参与统计。
 */

import type postgres from 'postgres';
import { pickText, type CommandContext } from '@gf/contracts';
import {
  settleDayPay, planTipPayouts, reconcileCash, VARIANCE_REASON_THRESHOLD_CENTS,
  type CashCount,
} from '@gf/payroll';
import { shiftRealMinutes } from '@gf/scheduling';
import { loadPlans } from '../money';
import { loadDayMoney, loadCashTipOwed } from '../handlers/dayclose';

// ─────────────────────────────────────────────────────── 技师当日收入看板

export interface StaffEarning {
  membershipId: string;
  name: string;
  /** 认到的营业额（提成基数） */
  serviceRevenueCents: number;
  commissionCents: number;
  tipCashCents: number;
  tipCardCents: number;
  /** 保底时薪那一份（按排班工时算，打卡上线后换成实际工时） */
  hourlyCents: number;
  minutesWorked: number;
  /** 实发 = 提成与保底取大 + 小费 */
  payCents: number;
  paidBy: 'commission' | 'hourly' | 'none';
  note: string;
  ticketCount: number;
  /** 今晚该拿多少现金（含昨日结转，减去已发） */
  cashTipOwedCents: number;
}

export interface EarningsBoard {
  businessDate: string;
  staff: StaffEarning[];
  totals: {
    serviceRevenueCents: number;
    commissionCents: number;
    tipCashCents: number;
    tipCardCents: number;
    payCents: number;
  };
}

export async function loadEarningsBoard(
  tx: postgres.TransactionSql,
  ctx: CommandContext,
  businessDate: string,
  /** 只看自己（技师只有 payroll.view_own 时） */
  onlyMembershipId?: string,
): Promise<EarningsBoard> {
  const rows = await tx<{
    membership_id: string; name: unknown; kind: string;
    amount: number; base: number; tickets: number;
  }[]>`
    select e.membership_id, sp.display_name as name, e.kind,
           sum(e.amount_cents)::int as amount,
           sum(e.base_cents)::int as base,
           count(distinct e.ticket_id)::int as tickets
    from earnings e
    left join staff_profiles sp on sp.membership_id = e.membership_id
    where e.location_id = ${ctx.locationId}
      and e.business_date = ${businessDate}
      and e.reversed_at is null
    group by e.membership_id, sp.display_name, e.kind`;

  const [{ tz } = { tz: 'America/New_York' }] = await tx<{ tz: string }[]>`
    select timezone as tz from locations where id = ${ctx.locationId}`;

  const shifts = await tx<{
    membership_id: string; start_min: number; end_min: number; break_min: number;
  }[]>`
    select membership_id, start_min, end_min, break_min
    from shifts
    where location_id = ${ctx.locationId} and business_date = ${businessDate}
      and status <> 'off'`;
  const minutesBy = new Map<string, number>();
  for (const s of shifts) {
    minutesBy.set(s.membership_id, shiftRealMinutes({
      businessDate, startMin: s.start_min, endMin: s.end_min, breakMin: s.break_min,
    }, tz));
  }

  const loaded = await loadPlans(tx, ctx.locationId);

  const byStaff = new Map<string, StaffEarning>();
  for (const r of rows) {
    if (onlyMembershipId && r.membership_id !== onlyMembershipId) continue;
    const cur = byStaff.get(r.membership_id) ?? {
      membershipId: r.membership_id,
      name: pickText(r.name, ctx.locale),
      serviceRevenueCents: 0, commissionCents: 0,
      tipCashCents: 0, tipCardCents: 0,
      hourlyCents: 0, minutesWorked: minutesBy.get(r.membership_id) ?? 0,
      payCents: 0, paidBy: 'none' as const, note: '',
      ticketCount: 0, cashTipOwedCents: 0,
    };
    if (r.kind === 'commission') {
      cur.commissionCents += r.amount;
      cur.serviceRevenueCents += r.base;
      cur.ticketCount = Math.max(cur.ticketCount, r.tickets);
    } else if (r.kind === 'tip_cash') {
      cur.tipCashCents += r.amount;
    } else if (r.kind === 'tip_card') {
      cur.tipCardCents += r.amount;
    } else if (r.kind === 'hourly' || r.kind === 'adjustment') {
      cur.payCents += r.amount;   // 手工调整直接进实发
    }
    byStaff.set(r.membership_id, cur);
  }

  // 已发的现金小费与昨日结转
  const payouts = await tx<{
    membership_id: string; paid: number; carry_in: number;
  }[]>`
    select membership_id,
           coalesce(sum(paid_cents) filter (where business_date = ${businessDate}), 0)::int as paid,
           coalesce(max(carry_out_cents) filter (where business_date < ${businessDate}), 0)::int as carry_in
    from tip_payouts
    where location_id = ${ctx.locationId} and business_date <= ${businessDate}
    group by membership_id`;
  const payoutBy = new Map(payouts.map((p) => [p.membership_id, p]));

  for (const s of byStaff.values()) {
    const plan = loaded.plans[s.membershipId] ?? loaded.fallback;
    const day = settleDayPay(s.commissionCents, s.minutesWorked, plan);
    s.hourlyCents = day.hourlyCents;
    s.paidBy = day.paidBy;
    s.note = day.note;
    // 小费永远是技师的，不参与保底比较 —— 拿小费冲抵保底工资是违法的
    s.payCents += day.payCents + s.tipCashCents + s.tipCardCents;

    const p = payoutBy.get(s.membershipId);
    s.cashTipOwedCents = s.tipCashCents - (p?.paid ?? 0) + (p?.carry_in ?? 0);
  }

  const staff = [...byStaff.values()].sort((a, b) => b.payCents - a.payCents);
  return {
    businessDate,
    staff,
    totals: {
      serviceRevenueCents: staff.reduce((s, x) => s + x.serviceRevenueCents, 0),
      commissionCents: staff.reduce((s, x) => s + x.commissionCents, 0),
      tipCashCents: staff.reduce((s, x) => s + x.tipCashCents, 0),
      tipCardCents: staff.reduce((s, x) => s + x.tipCardCents, 0),
      payCents: staff.reduce((s, x) => s + x.payCents, 0),
    },
  };
}

// ─────────────────────────────────────────────────────────────── 日结页

export interface DayCloseSnapshot {
  businessDate: string;
  status: 'open' | 'counted' | 'closed';
  openingFloatCents: number;
  closingFloatCents: number;
  countBreakdown: Record<string, number>;
  countedCashCents: number | null;
  expectedCashCents: number;
  cashVarianceCents: number;
  cashVarianceReason: string | null;
  cardExpectedCents: number;
  cardTerminalCents: number | null;
  cardVarianceCents: number | null;
  cardVarianceReason: string | null;
  money: {
    grossCents: number; discountCents: number; netCents: number; taxCents: number;
    cashTakeCents: number; cardTakeCents: number;
    tipCashCents: number; tipCardCents: number;
    movementsCents: number; tipPaidOutCents: number;
  };
  openTicketCount: number;
  movements: Array<{
    id: string; kind: string; amountCents: number; note: string | null; at: string;
  }>;
  /** 今晚要发的现金小费 */
  tipPayouts: Array<{
    membershipId: string; name: string;
    owedCents: number; payCents: number; carryOutCents: number;
    bills: Record<string, number>; alreadyPaidCents: number;
  }>;
  varianceThresholdCents: number;
}

export async function loadDayClose(
  tx: postgres.TransactionSql,
  ctx: CommandContext,
  businessDate: string,
): Promise<DayCloseSnapshot> {
  const [dc] = await tx<{
    status: string; opening: number; closing: number;
    breakdown: Record<string, number>; counted: number | null;
    cash_reason: string | null; card_terminal: number | null;
    card_variance: number | null; card_reason: string | null;
  }[]>`
    select status, opening_float_cents as opening, closing_float_cents as closing,
           count_breakdown as breakdown, counted_cash_cents as counted,
           cash_variance_reason as cash_reason, card_terminal_cents as card_terminal,
           card_variance_cents as card_variance, card_variance_reason as card_reason
    from day_closes where location_id = ${ctx.locationId} and business_date = ${businessDate}`;

  const money = await loadDayMoney(tx, ctx.locationId, businessDate);
  const opening = dc?.opening ?? 0;
  const closing = dc?.closing ?? 0;
  const counted = dc?.counted ?? null;

  const cash = reconcileCash({
    openingFloatCents: opening,
    cashTakeCents: money.cashTakeCents,
    movements: [
      { kind: 'other', amountCents: money.movementsCents },
      { kind: 'tip_payout', amountCents: -money.tipPaidOutCents },
    ],
    countedCents: counted ?? 0,
    closingFloatCents: closing,
  });

  const movements = await tx<{
    id: string; kind: string; amount_cents: number; note: string | null; at: string;
  }[]>`
    select id, kind, amount_cents, note, at::text as at
    from cash_movements
    where location_id = ${ctx.locationId} and business_date = ${businessDate}
    order by at`;

  const owed = await loadCashTipOwed(tx, ctx, businessDate);
  const plans = planTipPayouts(owed);
  const alreadyPaid = await tx<{ membership_id: string; paid: number }[]>`
    select membership_id, sum(paid_cents)::int as paid from tip_payouts
    where location_id = ${ctx.locationId} and business_date = ${businessDate}
    group by membership_id`;
  const paidBy = new Map(alreadyPaid.map((p) => [p.membership_id, p.paid]));

  return {
    businessDate,
    status: (dc?.status ?? 'open') as DayCloseSnapshot['status'],
    openingFloatCents: opening,
    closingFloatCents: closing,
    countBreakdown: dc?.breakdown ?? {},
    countedCashCents: counted,
    expectedCashCents: cash.expectedCents,
    cashVarianceCents: counted === null ? 0 : cash.varianceCents,
    cashVarianceReason: dc?.cash_reason ?? null,
    cardExpectedCents: money.cardTakeCents,
    cardTerminalCents: dc?.card_terminal ?? null,
    cardVarianceCents: dc?.card_variance ?? null,
    cardVarianceReason: dc?.card_reason ?? null,
    money: {
      grossCents: money.grossCents, discountCents: money.discountCents,
      netCents: money.netCents, taxCents: money.taxCents,
      cashTakeCents: money.cashTakeCents, cardTakeCents: money.cardTakeCents,
      tipCashCents: money.tipCashCents, tipCardCents: money.tipCardCents,
      movementsCents: money.movementsCents, tipPaidOutCents: money.tipPaidOutCents,
    },
    openTicketCount: money.openTicketCount,
    movements: movements.map((m) => ({
      id: m.id, kind: m.kind, amountCents: m.amount_cents, note: m.note, at: m.at,
    })),
    tipPayouts: plans.map((p) => ({
      membershipId: p.membershipId, name: p.name,
      owedCents: p.owedCents, payCents: p.payCents, carryOutCents: p.carryOutCents,
      bills: Object.fromEntries(
        Object.entries(p.bills as CashCount)
          .map(([k, v]) => [k, v as number])) as Record<string, number>,
      alreadyPaidCents: paidBy.get(p.membershipId) ?? 0,
    })),
    varianceThresholdCents: VARIANCE_REASON_THRESHOLD_CENTS,
  };
}

// ─────────────────────────────────────────────────────────────── 报表 v1

export interface ReportRow {
  key: string;
  label: string;
  grossCents: number;
  discountCents: number;
  netCents: number;
  taxCents: number;
  tipCents: number;
  totalCents: number;
  cashCents: number;
  cardCents: number;
  ticketCount: number;
}

export interface Report {
  fromDate: string;
  toDate: string;
  summary: ReportRow;
  byDay: ReportRow[];
  byStaff: Array<{
    key: string; label: string;
    serviceRevenueCents: number; commissionCents: number;
    tipCashCents: number; tipCardCents: number; ticketCount: number;
  }>;
  byService: Array<{ key: string; label: string; count: number; grossCents: number }>;
  voidedCount: number;
}

const EMPTY = (key: string, label: string): ReportRow => ({
  key, label, grossCents: 0, discountCents: 0, netCents: 0, taxCents: 0,
  tipCents: 0, totalCents: 0, cashCents: 0, cardCents: 0, ticketCount: 0,
});

export async function loadReport(
  tx: postgres.TransactionSql,
  ctx: CommandContext,
  fromDate: string,
  toDate: string,
): Promise<Report> {
  const days = await tx<{
    d: string; gross: number; discount: number; tax: number; tickets: number;
    tip: number; total: number;
  }[]>`
    select business_date::text as d,
           coalesce(sum(subtotal_cents), 0)::int as gross,
           coalesce(sum(discount_cents), 0)::int as discount,
           coalesce(sum(tax_cents), 0)::int as tax,
           count(*)::int as tickets,
           coalesce(sum(tip_cents), 0)::int as tip,
           coalesce(sum(total_cents), 0)::int as total
    from tickets
    where location_id = ${ctx.locationId}
      and business_date between ${fromDate} and ${toDate}
      and status = 'closed'
    group by business_date
    order by business_date`;

  // 支付方式拆分单独查一遍。别想着在上面那条里用子查询把 payments 卷进来 ——
  // 一张单可以有多行收款（一部分现金一部分刷卡），join 上去会让 tickets
  // 的金额按收款行数翻倍，而且翻得毫无规律
  const paysByDay = await tx<{ d: string; cash: number; card: number }[]>`
    select t.business_date::text as d,
           coalesce(sum(p.amount_cents) filter (where p.method = 'cash'), 0)::int as cash,
           coalesce(sum(p.amount_cents) filter (where p.method <> 'cash'), 0)::int as card
    from payments p
    join tickets t on t.id = p.ticket_id
    where t.location_id = ${ctx.locationId}
      and t.business_date between ${fromDate} and ${toDate}
      and t.status = 'closed'
    group by t.business_date`;
  const payBy = new Map(paysByDay.map((p) => [p.d, p]));

  const byDay = days.map((r) => ({
    key: r.d, label: r.d,
    grossCents: r.gross, discountCents: r.discount,
    netCents: r.gross - r.discount, taxCents: r.tax,
    tipCents: r.tip, totalCents: r.total,
    cashCents: payBy.get(r.d)?.cash ?? 0,
    cardCents: payBy.get(r.d)?.card ?? 0,
    ticketCount: r.tickets,
  }));

  const summary = byDay.reduce((acc, r) => ({
    ...acc,
    grossCents: acc.grossCents + r.grossCents,
    discountCents: acc.discountCents + r.discountCents,
    netCents: acc.netCents + r.netCents,
    taxCents: acc.taxCents + r.taxCents,
    tipCents: acc.tipCents + r.tipCents,
    totalCents: acc.totalCents + r.totalCents,
    cashCents: acc.cashCents + r.cashCents,
    cardCents: acc.cardCents + r.cardCents,
    ticketCount: acc.ticketCount + r.ticketCount,
  }), EMPTY('summary', `${fromDate} ~ ${toDate}`));

  const staffRows = await tx<{
    membership_id: string; name: unknown; kind: string; amount: number; base: number; tickets: number;
  }[]>`
    select e.membership_id, sp.display_name as name, e.kind,
           sum(e.amount_cents)::int as amount, sum(e.base_cents)::int as base,
           count(distinct e.ticket_id)::int as tickets
    from earnings e
    left join staff_profiles sp on sp.membership_id = e.membership_id
    where e.location_id = ${ctx.locationId}
      and e.business_date between ${fromDate} and ${toDate}
      and e.reversed_at is null
    group by e.membership_id, sp.display_name, e.kind`;

  const staffMap = new Map<string, Report['byStaff'][number]>();
  for (const r of staffRows) {
    const cur = staffMap.get(r.membership_id) ?? {
      key: r.membership_id, label: pickText(r.name, ctx.locale),
      serviceRevenueCents: 0, commissionCents: 0,
      tipCashCents: 0, tipCardCents: 0, ticketCount: 0,
    };
    if (r.kind === 'commission') {
      cur.commissionCents += r.amount;
      cur.serviceRevenueCents += r.base;
      cur.ticketCount = Math.max(cur.ticketCount, r.tickets);
    } else if (r.kind === 'tip_cash') cur.tipCashCents += r.amount;
    else if (r.kind === 'tip_card') cur.tipCardCents += r.amount;
    staffMap.set(r.membership_id, cur);
  }

  const services = await tx<{ name: string; n: number; gross: number }[]>`
    select ti.name_snapshot as name, count(*)::int as n,
           coalesce(sum(ti.total_cents), 0)::int as gross
    from ticket_items ti
    join tickets t on t.id = ti.ticket_id
    where t.location_id = ${ctx.locationId}
      and t.business_date between ${fromDate} and ${toDate}
      and t.status = 'closed'
    group by ti.name_snapshot
    order by gross desc
    limit 100`;

  const [voided] = await tx<{ n: number }[]>`
    select count(*)::int as n from tickets
    where location_id = ${ctx.locationId}
      and business_date between ${fromDate} and ${toDate} and status = 'voided'`;

  return {
    fromDate, toDate, summary, byDay,
    byStaff: [...staffMap.values()].sort((a, b) => b.serviceRevenueCents - a.serviceRevenueCents),
    byService: services.map((s) => ({
      key: s.name, label: s.name, count: s.n, grossCents: s.gross,
    })),
    voidedCount: voided?.n ?? 0,
  };
}

// ─────────────────────────────────────────────────────────────── CSV

const money = (c: number) => (c / 100).toFixed(2);

/**
 * CSV 转义。
 * 逗号、引号、换行、以及**开头的 = + - @** 都要处理 ——
 * 最后一条是防 Excel 把 `=1+1` 当公式执行（CSV 注入），
 * 门店会把这个文件发给会计，不能带一个能执行的东西过去。
 */
function csvCell(v: string | number): string {
  const s = String(v);
  const risky = /^[=+\-@\t\r]/.test(s);
  const body = risky ? `'${s}` : s;
  return /[",\n\r]/.test(body) ? `"${body.replace(/"/g, '""')}"` : body;
}

export function reportToCsv(r: Report): string {
  const lines: string[] = [];
  const row = (...cells: Array<string | number>) => lines.push(cells.map(csvCell).join(','));

  row('GenieFront 营业报表', `${r.fromDate} ~ ${r.toDate}`);
  lines.push('');

  row('汇总');
  row('原价 Gross', '折扣 Discount', '净额 Net', '税 Tax', '小费 Tips',
      '实收 Total', '现金 Cash', '刷卡 Card', '单数 Tickets', '作废 Voided');
  row(money(r.summary.grossCents), money(r.summary.discountCents), money(r.summary.netCents),
      money(r.summary.taxCents), money(r.summary.tipCents), money(r.summary.totalCents),
      money(r.summary.cashCents), money(r.summary.cardCents),
      r.summary.ticketCount, r.voidedCount);
  lines.push('');

  row('按天');
  row('日期', '原价', '折扣', '净额', '税', '小费', '实收', '现金', '刷卡', '单数');
  for (const d of r.byDay) {
    row(d.key, money(d.grossCents), money(d.discountCents), money(d.netCents),
        money(d.taxCents), money(d.tipCents), money(d.totalCents),
        money(d.cashCents), money(d.cardCents), d.ticketCount);
  }
  lines.push('');

  row('按技师');
  row('技师', '认到营业额', '提成', '现金小费', '刷卡小费', '单数');
  for (const s of r.byStaff) {
    row(s.label, money(s.serviceRevenueCents), money(s.commissionCents),
        money(s.tipCashCents), money(s.tipCardCents), s.ticketCount);
  }
  lines.push('');

  row('按项目');
  row('项目', '次数', '营业额');
  for (const s of r.byService) row(s.label, s.count, money(s.grossCents));

  // ﻿：不带 BOM 的话 Excel 打开中文列名是乱码，
  // 而门店的第一反应会是「这系统导出的东西有问题」
  return '﻿' + lines.join('\r\n') + '\r\n';
}
