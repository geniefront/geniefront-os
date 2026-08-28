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
  safeDropCents: number;
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
  terminalBatches?: Array<{
    terminalId: string;
    terminalName: string;
    status: 'settled' | 'open' | 'offline';
    transactionCount: number;
    amountCents: number;
  }>;
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
    status: string; opening: number; closing: number | null;
    breakdown: Record<string, number> | null; counted: number | null;
    cash_reason: string | null; card_terminal: number | null;
    card_variance: number | null; card_reason: string | null;
    terminal_batches: Array<{
      terminalId: string; terminalName: string; status: 'settled' | 'open' | 'offline';
      transactionCount: number; amountCents: number;
    }> | null;
  }[]>`
    select status, opening_float_cents as opening, closing_float_cents as closing,
           count_breakdown as breakdown, counted_cash_cents as counted,
           cash_variance_reason as cash_reason, card_terminal_cents as card_terminal,
           card_variance_cents as card_variance, card_variance_reason as card_reason,
           terminal_batches
    from day_closes where location_id = ${ctx.locationId} and business_date = ${businessDate}`;

  const money = await loadDayMoney(tx, ctx.locationId, businessDate);
  const opening = dc?.opening ?? 0;
  const closing = dc?.closing ?? 20000;
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

  const rawBreakdown = (dc?.breakdown ?? {}) as Record<string, number>;
  const countBreakdown: Record<string, number> = {
    bill_100: rawBreakdown.bill_100 ?? rawBreakdown['10000'] ?? 0,
    bill_50: rawBreakdown.bill_50 ?? rawBreakdown['5000'] ?? 0,
    bill_20: rawBreakdown.bill_20 ?? rawBreakdown['2000'] ?? 0,
    bill_10: rawBreakdown.bill_10 ?? rawBreakdown['1000'] ?? 0,
    bill_5: rawBreakdown.bill_5 ?? rawBreakdown['500'] ?? 0,
    bill_2: rawBreakdown.bill_2 ?? rawBreakdown['200'] ?? 0,
    bill_1: rawBreakdown.bill_1 ?? rawBreakdown['100'] ?? 0,
    coin_25: rawBreakdown.coin_25 ?? rawBreakdown['25'] ?? 0,
    coin_10: rawBreakdown.coin_10 ?? rawBreakdown['10'] ?? 0,
    coin_5: rawBreakdown.coin_5 ?? rawBreakdown['5'] ?? 0,
    coin_1: rawBreakdown.coin_1 ?? rawBreakdown['1'] ?? 0,
    ...rawBreakdown,
  };

  const safeDropCents = Math.max(0, (counted ?? cash.expectedCents) - closing);

  const terminalBatches = dc?.terminal_batches ?? [
    {
      terminalId: 'tm_01_frontdesk',
      terminalName: '前台主 POS 终端 (WisePOS E)',
      status: (dc?.status === 'closed' ? 'settled' : 'open') as 'settled' | 'open',
      transactionCount: Math.max(0, Math.round(money.cardTakeCents / 4500)),
      amountCents: money.cardTakeCents,
    },
  ];

  return {
    businessDate,
    status: (dc?.status ?? 'open') as DayCloseSnapshot['status'],
    openingFloatCents: opening,
    closingFloatCents: closing,
    safeDropCents,
    countBreakdown,
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
    terminalBatches,
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

/**
 * ⭐ 一天的记录状况（0032）。
 *
 * 报表里最危险的一件事是**把「那天做了 0 块」和「那天没人记」画成同一根柱子**。
 * 前者是经营事实，后者是数据缺口 —— 混在一起，老板会拿一个残的数去做决定，
 * 而且看不出它是残的。所以 byDay 的每一行都必须自己说清楚它是哪一种。
 */
export type DayStatus =
  /** 有单，已封账。唯一可以完全信任的一档 */
  | 'ok'
  /** 有单，但那天没人按封账。数都在，只是没盖章 */
  | 'unclosed'
  /** 那天用纸记的，补了个总数进来。营业额可信，**提成是空的** */
  | 'summary_only'
  /** 那天没营业。这是**真实的 0**，进平均值不失真 */
  | 'no_business'
  /** 那天开着门用纸记的，明确决定不补。报表里是空白，不是 0 */
  | 'paper_only'
  /** 什么都没有，也没人说过这天是怎么回事 */
  | 'no_record';

/** 这一行的钱能不能算进合计 */
const COUNTS_TOWARD_TOTAL: Record<DayStatus, boolean> = {
  ok: true, unclosed: true, summary_only: true,
  no_business: true,        // 真实的 0，加进去不改变任何数，但要占一天
  paper_only: false,        // 有生意，但数不在系统里 —— 加进去等于编造
  no_record: false,
};

export interface DayReportRow extends ReportRow {
  status: DayStatus;
  /** 那天有没有技师提成明细。summary_only / paper_only / no_record 都没有 */
  hasEarnings: boolean;
  /** 断档时人填的说明：「Lily 请假，我用本子记的」 */
  note: string | null;
}

/**
 * 区间的完整程度。**这个对象存在的唯一理由**是让界面有办法在合计旁边
 * 说一句「这个数不是全周的」—— 没有它，界面只能默默显示一个残数。
 */
export interface ReportCoverage {
  daysInRange: number;
  /** 数完整可信的天数（ok + unclosed + no_business） */
  daysComplete: number;
  /** 只有总数、没有提成明细的天数 */
  daysSummaryOnly: number;
  /** 数根本不在系统里的天数（paper_only + no_record） */
  daysMissing: number;
  /** 还没人处理过的天数 —— 界面拿它决定要不要提醒去补 */
  daysUnhandled: number;
  /** daysMissing === 0 && daysSummaryOnly === 0 时才为 true */
  complete: boolean;
}

export interface Report {
  fromDate: string;
  toDate: string;
  summary: ReportRow;
  /** ⭐ 区间完整度。界面必须在合计旁边把 daysMissing 说出来 */
  coverage: ReportCoverage;
  byDay: DayReportRow[];
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

/**
 * 区间里的每一天，含首尾。
 *
 * 用 UTC 推进而不是本地时区：营业日在库里是一个纯 `date`，没有时刻也没有时区，
 * 拿本地时间去加一天，在夏令时切换的那两天会少一天或多一天 ——
 * 而那正好是一年里最不该出错的两天（老板会拿它跟去年同期比）。
 */
export function eachDate(fromDate: string, toDate: string): string[] {
  const out: string[] = [];
  const end = Date.parse(`${toDate}T00:00:00Z`);
  let cur = Date.parse(`${fromDate}T00:00:00Z`);
  if (Number.isNaN(cur) || Number.isNaN(end)) return out;
  while (cur <= end) {
    out.push(new Date(cur).toISOString().slice(0, 10));
    cur += 86_400_000;
  }
  return out;
}

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
           -- ⚠️ **礼品卡既不是现金也不是刷卡**（批 8 收尾）。
      -- 算进刷卡的话，晚上和刷卡机的 batch total 就永远差出这一笔 ——
      -- 而那正是日结要发现的那种差额。external 保持原样归在刷卡侧。
      coalesce(sum(p.amount_cents) filter (where p.method = 'cash'), 0)::int as cash,
           coalesce(sum(p.amount_cents) filter (where p.method not in ('cash','gift_card')), 0)::int as card
    from payments p
    join tickets t on t.id = p.ticket_id
    where t.location_id = ${ctx.locationId}
      and t.business_date between ${fromDate} and ${toDate}
      and t.status = 'closed'
    group by t.business_date`;
  const payBy = new Map(paysByDay.map((p) => [p.d, p]));

  // ⭐ 那天被人怎么标过（0032）。没有这一查，「没记」就会伪装成「0」
  const marks = await tx<{
    d: string; status: string; note: string | null;
    b_gross: number | null; b_cash: number | null; b_card: number | null;
    b_tip_cash: number | null; b_tip_card: number | null;
  }[]>`
    select business_date::text as d, status, gap_note as note,
           backfill_gross_cents    as b_gross,
           backfill_cash_cents     as b_cash,
           backfill_card_cents     as b_card,
           backfill_tip_cash_cents as b_tip_cash,
           backfill_tip_card_cents as b_tip_card
    from day_closes
    where location_id = ${ctx.locationId}
      and business_date between ${fromDate} and ${toDate}`;
  const markBy = new Map(marks.map((m) => [m.d, m]));
  const dayBy = new Map(days.map((r) => [r.d, r]));

  /**
   * ⭐ 把区间**铺满**，而不是只回有数据的天。
   *
   * 改这一行之前，`group by business_date` 让没记的那天根本不出现在结果里 ——
   * 前端拿到的数组里它就是不存在，合计静默偏低，而且看不出来。
   * 断档本身不致命，**因断档而失去信任才致命**：老板哪天发现周报是错的，
   * 从那一刻起他不再信这个系统里的任何数字。
   */
  const byDay: DayReportRow[] = eachDate(fromDate, toDate).map((d) => {
    const r = dayBy.get(d);
    const m = markBy.get(d);
    const note = m?.note ?? null;

    // 有真实工单：数据是真的，只看盖没盖章
    if (r) {
      return {
        key: d, label: d,
        grossCents: r.gross, discountCents: r.discount,
        netCents: r.gross - r.discount, taxCents: r.tax,
        tipCents: r.tip, totalCents: r.total,
        cashCents: payBy.get(d)?.cash ?? 0,
        cardCents: payBy.get(d)?.card ?? 0,
        ticketCount: r.tickets,
        status: m?.status === 'closed' ? 'ok' : 'unclosed',
        hasEarnings: true,
        note,
      };
    }

    // 没有工单：这天是什么，完全取决于有没有人说过话
    if (m?.status === 'summary_only') {
      const gross = m.b_gross ?? 0;
      return {
        ...EMPTY(d, d),
        grossCents: gross,
        netCents: gross,                       // 补录不拆折扣，原价即净额
        tipCents: (m.b_tip_cash ?? 0) + (m.b_tip_card ?? 0),
        totalCents: gross + (m.b_tip_cash ?? 0) + (m.b_tip_card ?? 0),
        cashCents: m.b_cash ?? 0,
        cardCents: m.b_card ?? 0,
        status: 'summary_only' as const,
        // ⚠️ 补了总数**不等于**补了提成。系统不知道那天哪一单是谁做的，
        //    所以 earnings 一条都没有 —— 这个 false 是要一路传到界面上的
        hasEarnings: false,
        note,
      };
    }
    if (m?.status === 'no_business') {
      return { ...EMPTY(d, d), status: 'no_business' as const, hasEarnings: false, note };
    }
    if (m?.status === 'paper_only') {
      return { ...EMPTY(d, d), status: 'paper_only' as const, hasEarnings: false, note };
    }
    return { ...EMPTY(d, d), status: 'no_record' as const, hasEarnings: false, note };
  });

  // 合计只加「钱在系统里」的天。paper_only / no_record 加进去等于编造收入
  const summary = byDay
    .filter((r) => COUNTS_TOWARD_TOTAL[r.status])
    .reduce((acc, r) => ({
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

  const coverage: ReportCoverage = {
    daysInRange: byDay.length,
    daysComplete: byDay.filter((r) =>
      r.status === 'ok' || r.status === 'unclosed' || r.status === 'no_business').length,
    daysSummaryOnly: byDay.filter((r) => r.status === 'summary_only').length,
    daysMissing: byDay.filter((r) =>
      r.status === 'paper_only' || r.status === 'no_record').length,
    // 「还没人处理过」只算 no_record —— paper_only 是有人明确决定过的，
    // 再去提醒他补，就是在惩罚一个已经做过的决定
    daysUnhandled: byDay.filter((r) => r.status === 'no_record').length,
    complete: false,
  };
  coverage.complete = coverage.daysMissing === 0 && coverage.daysSummaryOnly === 0;

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
    fromDate, toDate, summary, coverage, byDay,
    byStaff: [...staffMap.values()].sort((a, b) => b.serviceRevenueCents - a.serviceRevenueCents),
    byService: services.map((s) => ({
      key: s.name, label: s.name, count: s.n, grossCents: s.gross,
    })),
    voidedCount: voided?.n ?? 0,
  };
}

// ─────────────────────────────────────────────────────────────── CSV

const money = (c: number) => (c / 100).toFixed(2);

/** CSV 里那一列人话。会计看的是这一列，不是 status 那个英文枚举 */
const DAY_STATUS_CN: Record<DayStatus, string> = {
  ok: '',
  unclosed: '有单未封账',
  summary_only: '只补了总数（无提成明细）',
  no_business: '没营业',
  paper_only: '用纸记的，未补录',
  no_record: '没有记录',
};

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

  // ⭐ 完整度紧跟在汇总下面，而不是塞在文件末尾。
  //    会计打开这个文件看的第一眼就是汇总那几个数 ——
  //    「这个数是残的」必须出现在同一屏里，否则等于没说
  row('记录完整度');
  if (r.coverage.complete) {
    row(`这 ${r.coverage.daysInRange} 天全部记完，上面的汇总是完整的`);
  } else {
    row(`区间共 ${r.coverage.daysInRange} 天`,
        `完整 ${r.coverage.daysComplete} 天`,
        `只有总数 ${r.coverage.daysSummaryOnly} 天`,
        `没有数据 ${r.coverage.daysMissing} 天`);
    row('⚠️ 上面的汇总不含「没有数据」那几天，拿它跟别的区间比会得出错的结论');
  }
  lines.push('');

  row('按天');
  row('日期', '原价', '折扣', '净额', '税', '小费', '实收', '现金', '刷卡', '单数', '记录情况');
  for (const d of r.byDay) {
    // ⭐ 没记的那天在 CSV 里也必须是空格而不是 0.00 —— 这个文件是发给会计的，
    //    一列 0.00 会被当成「那天真的没做生意」记进账，而且再也纠不回来
    const blank = d.status === 'no_record' || d.status === 'paper_only';
    const cell = (c: number) => (blank ? '' : money(c));
    row(d.key, cell(d.grossCents), cell(d.discountCents), cell(d.netCents),
        cell(d.taxCents), cell(d.tipCents), cell(d.totalCents),
        cell(d.cashCents), cell(d.cardCents), blank ? '' : d.ticketCount,
        DAY_STATUS_CN[d.status]);
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
