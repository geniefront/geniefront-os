/**
 * 打烊日结命令实现。
 *
 * 算账全在 @gf/payroll/settle 的纯函数里（宪法第 2 条），
 * 这里只做「取数 → 调纯函数 → 落库」。
 *
 * 一条贯穿的立场：**系统不追求「不许差」，只追求「差额有出处」**。
 */

import type postgres from 'postgres';
import {
  RecordCashMovement, SaveCashCount, PayCashTips, FinalizeDay, ReopenDay, MarkGapDay,
  AppError, ERROR_CODES, pickText, type CommandContext,
} from '@gf/contracts';
import {
  countCash, reconcileCash, reconcileCard, planTipPayouts,
  VARIANCE_REASON_THRESHOLD_CENTS,
  type CashCount, type Denomination, type CashMovement,
} from '@gf/payroll';
import { businessDateOf } from '@gf/scheduling';
import { jsonb } from '@gf/db';
import { registerHandler, type HandlerArgs } from '../bus';

/** 当前营业日。命令都允许显式传日期（补录昨天的账是常事） */
export async function resolveDate(
  tx: postgres.TransactionSql, locationId: string, given?: string,
): Promise<string> {
  if (given) return given;
  const [loc] = await tx<{ tz: string; cutoff: string }[]>`
    select timezone as tz, business_day_cutoff::text as cutoff
    from locations where id = ${locationId}`;
  if (!loc) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'location' } });
  return businessDateOf(new Date(), loc.tz, loc.cutoff);
}

/** 确保有一条 day_closes，返回它 */
async function ensureDayClose(
  tx: postgres.TransactionSql, ctx: CommandContext, date: string,
): Promise<{ id: string; status: string; openingFloatCents: number; closingFloatCents: number }> {
  const [row] = await tx<{
    id: string; status: string; opening_float_cents: number; closing_float_cents: number;
  }[]>`
    insert into day_closes (org_id, location_id, business_date)
    values (${ctx.orgId}, ${ctx.locationId}, ${date})
    on conflict (location_id, business_date) do update set business_date = excluded.business_date
    returning id, status, opening_float_cents, closing_float_cents`;
  return {
    id: row!.id,
    status: row!.status,
    openingFloatCents: row!.opening_float_cents,
    closingFloatCents: row!.closing_float_cents,
  };
}

function assertNotClosed(status: string, date: string): void {
  if (status === 'closed') {
    throw new AppError(ERROR_CODES.DAY_ALREADY_CLOSED, {
      details: { businessDate: date, hint: '要改这一天，先重新打开' },
    });
  }
}

// ────────────────────────────────────────────────────────────── 当日钱的快照

export interface DayMoney {
  cashTakeCents: number;     // 现金收款（含小费）
  cardTakeCents: number;     // 刷卡收款（含小费）
  grossCents: number;        // 服务原价合计
  discountCents: number;
  netCents: number;
  taxCents: number;
  tipCashCents: number;
  tipCardCents: number;
  movementsCents: number;    // 现金进出净额（不含小费发放）
  tipPaidOutCents: number;   // 已发的现金小费
  openTicketCount: number;
}

/**
 * 一天的钱长什么样。日结页、封账、报表都吃这一份，只算一次。
 *
 * ⚠️ 作废的单一行都不进（宪法第 9 条：取消/作废不计入营业额）。
 */
export async function loadDayMoney(
  tx: postgres.TransactionSql, locationId: string, date: string,
): Promise<DayMoney> {
  const [pay] = await tx<{
    cash: number; card: number; tip_cash: number; tip_card: number;
  }[]>`
    select
      coalesce(sum(p.amount_cents) filter (where p.method = 'cash'), 0)::int as cash,
      coalesce(sum(p.amount_cents) filter (where p.method <> 'cash'), 0)::int as card,
      coalesce(sum(p.tip_cents)    filter (where p.method = 'cash'), 0)::int as tip_cash,
      coalesce(sum(p.tip_cents)    filter (where p.method <> 'cash'), 0)::int as tip_card
    from payments p
    join tickets t on t.id = p.ticket_id
    where p.location_id = ${locationId}
      and t.business_date = ${date} and t.status = 'closed'`;

  const [tk] = await tx<{
    gross: number; discount: number; tax: number; open_count: number;
  }[]>`
    select
      coalesce(sum(subtotal_cents) filter (where status = 'closed'), 0)::int as gross,
      coalesce(sum(discount_cents) filter (where status = 'closed'), 0)::int as discount,
      coalesce(sum(tax_cents)      filter (where status = 'closed'), 0)::int as tax,
      count(*) filter (where status in ('open','in_service','ready_to_pay'))::int as open_count
    from tickets
    where location_id = ${locationId} and business_date = ${date}`;

  // ⚠️ opening_float 不算流水：它已经作为 day_closes.opening_float_cents
  // 进了期望现金的起始额。两边都算就是把备用金数两遍 ——
  // 症状是每天的差异恰好等于备用金，而前台会以为自己多收了钱。
  const [mv] = await tx<{ movements: number; tip_out: number }[]>`
    select
      coalesce(sum(amount_cents)
               filter (where kind not in ('tip_payout','opening_float')), 0)::int as movements,
      coalesce(-sum(amount_cents) filter (where kind = 'tip_payout'), 0)::int as tip_out
    from cash_movements
    where location_id = ${locationId} and business_date = ${date}`;

  const gross = tk?.gross ?? 0;
  const discount = tk?.discount ?? 0;
  return {
    cashTakeCents: pay?.cash ?? 0,
    cardTakeCents: pay?.card ?? 0,
    grossCents: gross,
    discountCents: discount,
    netCents: gross - discount,
    taxCents: tk?.tax ?? 0,
    tipCashCents: pay?.tip_cash ?? 0,
    tipCardCents: pay?.tip_card ?? 0,
    movementsCents: mv?.movements ?? 0,
    tipPaidOutCents: mv?.tip_out ?? 0,
    openTicketCount: tk?.open_count ?? 0,
  };
}

/** 把 DayMoney 换算成对账要的入参 */
function toReconcileInput(m: DayMoney, opening: number, closing: number, counted: number) {
  const movements: CashMovement[] = [
    { kind: 'other', amountCents: m.movementsCents },
    { kind: 'tip_payout', amountCents: -m.tipPaidOutCents },
  ];
  return {
    openingFloatCents: opening,
    cashTakeCents: m.cashTakeCents,
    movements,
    countedCents: counted,
    closingFloatCents: closing,
  };
}

// ────────────────────────────────────────────────────────────── 现金进出

registerHandler(RecordCashMovement, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof RecordCashMovement.input._type>) => {
  const date = await resolveDate(tx, ctx.locationId, input.businessDate);
  const dc = await ensureDayClose(tx, ctx, date);
  assertNotClosed(dc.status, date);

  const [row] = await tx<{ id: string }[]>`
    insert into cash_movements
      (org_id, location_id, business_date, kind, amount_cents, note, actor_id)
    values (${ctx.orgId}, ${ctx.locationId}, ${date}, ${input.kind},
            ${input.amountCents}, ${input.note ?? null}, ${ctx.membershipId})
    returning id`;

  // 备用金单独记一份到 day_closes，对账时它是起始额而不是流水
  if (input.kind === 'opening_float') {
    await tx`update day_closes set opening_float_cents = ${Math.abs(input.amountCents)}
             where location_id = ${ctx.locationId} and business_date = ${date}`;
  }

  audit({ entityType: 'cash_movement', entityId: row!.id,
          after: { kind: input.kind, businessDate: date, note: input.note ?? null } });
  return { movementId: row!.id, businessDate: date };
});

// ────────────────────────────────────────────────────────────── 点钞与刷卡对账

registerHandler(SaveCashCount, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof SaveCashCount.input._type>) => {
  const date = await resolveDate(tx, ctx.locationId, input.businessDate);
  const dc = await ensureDayClose(tx, ctx, date);
  assertNotClosed(dc.status, date);

  const breakdown: CashCount = {};
  for (const [k, v] of Object.entries(input.breakdown)) {
    breakdown[Number(k) as Denomination] = v;
  }
  const hasBreakdown = Object.keys(input.breakdown).length > 0;
  // 两个都给时以面额表为准 —— 手动填的总额多半是先填的那个
  const counted = hasBreakdown ? countCash(breakdown) : (input.countedCashCents ?? 0);

  const money = await loadDayMoney(tx, ctx.locationId, date);
  const opening = input.openingFloatCents ?? dc.openingFloatCents;
  const closing = input.closingFloatCents ?? dc.closingFloatCents;

  const cash = reconcileCash(toReconcileInput(money, opening, closing, counted));
  const card = reconcileCard(
    money.cardTakeCents,
    input.cardTerminalCents ?? money.cardTakeCents,   // 没敲终端数就当作平
  );

  await tx`update day_closes set
      status = 'counted',
      count_breakdown = ${jsonb(input.breakdown)}::jsonb,
      counted_cash_cents = ${counted},
      expected_cash_cents = ${cash.expectedCents},
      cash_variance_cents = ${cash.varianceCents},
      cash_variance_reason = ${input.cashVarianceReason ?? null},
      opening_float_cents = ${opening},
      closing_float_cents = ${closing},
      card_terminal_cents = ${input.cardTerminalCents ?? null},
      card_expected_cents = ${card.expectedCents},
      card_variance_cents = ${input.cardTerminalCents === undefined ? null : card.varianceCents},
      card_variance_reason = ${input.cardVarianceReason ?? null},
      note = ${input.note ?? null},
      counted_by = ${ctx.membershipId},
      counted_at = now()
    where location_id = ${ctx.locationId} and business_date = ${date}`;

  // 审计留动作不留金额：谁点的钞、几点点的、差异要不要解释
  audit({
    entityType: 'day_close', entityId: dc.id,
    after: {
      businessDate: date, status: 'counted',
      byDenomination: hasBreakdown,
      cashNeedsReason: cash.needsReason,
      cardNeedsReason: input.cardTerminalCents !== undefined && card.needsReason,
    },
  });

  return {
    businessDate: date,
    countedCashCents: counted,
    expectedCashCents: cash.expectedCents,
    cashVarianceCents: cash.varianceCents,
    cardExpectedCents: card.expectedCents,
    cardVarianceCents: input.cardTerminalCents === undefined ? 0 : card.varianceCents,
    needsCashReason: cash.needsReason,
    needsCardReason: input.cardTerminalCents !== undefined && card.needsReason,
  };
});

// ────────────────────────────────────────────────────────────── 现金小费发放

/**
 * 某人某天该拿多少现金小费 = 当天分配额（未冲销）− 已发 + 昨日结转。
 *
 * 「昨日结转」取的是**最近一次**发放记录的 carry_out，而不是历史累加 ——
 * 每次发放都会把结转写进那一天的记录里，累加会重复计算。
 */
async function loadCashTipOwed(
  tx: postgres.TransactionSql, ctx: CommandContext, date: string,
  only?: readonly string[],
): Promise<Array<{ membershipId: string; name: string; todayCents: number; carryInCents: number }>> {
  const rows = await tx<{
    membership_id: string; name: unknown; today: number; already: number; carry_in: number;
  }[]>`
    with today_tips as (
      select ta.membership_id, sum(ta.amount_cents)::int as amount
      from tip_allocations ta
      join tickets t on t.id = ta.ticket_id
      where ta.location_id = ${ctx.locationId}
        and t.business_date = ${date}
        and t.status = 'closed'
        and ta.source = 'cash'
        and ta.reversed_at is null
      group by ta.membership_id
    ),
    paid as (
      select membership_id, sum(paid_cents)::int as paid
      from tip_payouts
      where location_id = ${ctx.locationId} and business_date = ${date}
      group by membership_id
    ),
    carry as (
      select distinct on (membership_id) membership_id, carry_out_cents
      from tip_payouts
      where location_id = ${ctx.locationId} and business_date < ${date}
      order by membership_id, business_date desc
    )
    select coalesce(tt.membership_id, c.membership_id) as membership_id,
           sp.display_name as name,
           coalesce(tt.amount, 0) as today,
           coalesce(p.paid, 0) as already,
           coalesce(c.carry_out_cents, 0) as carry_in
    from today_tips tt
    full outer join carry c on c.membership_id = tt.membership_id
    left join paid p on p.membership_id = coalesce(tt.membership_id, c.membership_id)
    left join staff_profiles sp on sp.membership_id = coalesce(tt.membership_id, c.membership_id)
    where coalesce(tt.amount, 0) <> 0 or coalesce(c.carry_out_cents, 0) <> 0`;

  return rows
    .filter((r) => !only || only.includes(r.membership_id))
    .map((r) => ({
      membershipId: r.membership_id,
      name: pickText(r.name, ctx.locale),
      todayCents: r.today - r.already,
      carryInCents: r.carry_in,
    }));
}

export { loadCashTipOwed };

registerHandler(PayCashTips, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof PayCashTips.input._type>) => {
  const date = await resolveDate(tx, ctx.locationId, input.businessDate);
  const dc = await ensureDayClose(tx, ctx, date);
  assertNotClosed(dc.status, date);

  const owed = await loadCashTipOwed(tx, ctx, date, input.membershipIds);
  // 服务端重算一遍：前端算的数只是给人看的，落库的必须是这里算的
  const plans = planTipPayouts(owed, input.roundToCents);

  let totalPaid = 0;
  for (const p of plans) {
    if (p.payCents === 0 && p.carryOutCents === 0) continue;

    const [row] = await tx<{ id: string }[]>`
      insert into tip_payouts
        (org_id, location_id, business_date, membership_id,
         owed_cents, paid_cents, carry_in_cents, carry_out_cents, bills, paid_by)
      values (${ctx.orgId}, ${ctx.locationId}, ${date}, ${p.membershipId},
              ${p.owedCents}, ${p.payCents},
              ${owed.find((o) => o.membershipId === p.membershipId)?.carryInCents ?? 0},
              ${p.carryOutCents}, ${jsonb(p.bills)}::jsonb, ${ctx.membershipId})
      -- 一天里可能发两次（先发了一半，晚点又有单结账）。
      -- owed 必须重新推导成「已发的全部 + 还欠的零头」，
      -- 直接把两次的 owed 相加会把结转部分重复计入，
      -- 当场违反 tip_payout_balances 那条约束（这正是它存在的意义）。
      on conflict (location_id, business_date, membership_id) do update set
        paid_cents = tip_payouts.paid_cents + excluded.paid_cents,
        owed_cents = tip_payouts.paid_cents + excluded.paid_cents + excluded.carry_out_cents,
        carry_out_cents = excluded.carry_out_cents,
        bills = excluded.bills,
        paid_by = excluded.paid_by,
        at = now()
      returning id`;

    if (p.payCents > 0) {
      // 现金小费出抽屉必须记一笔，否则点钞会平白少这么多
      await tx`insert into cash_movements
        (org_id, location_id, business_date, kind, amount_cents, note, tip_payout_id, actor_id)
        values (${ctx.orgId}, ${ctx.locationId}, ${date}, 'tip_payout',
                ${-p.payCents}, ${`发放现金小费：${p.name}`}, ${row!.id}, ${ctx.membershipId})`;
      totalPaid += p.payCents;
    }
  }

  audit({
    entityType: 'day_close', entityId: dc.id,
    after: {
      businessDate: date, action: 'payTips',
      staffCount: plans.filter((p) => p.payCents > 0).length,
      roundToCents: input.roundToCents,
    },
  });

  return {
    businessDate: date,
    totalPaidCents: totalPaid,
    payouts: plans.map((p) => ({
      membershipId: p.membershipId, name: p.name,
      owedCents: p.owedCents, paidCents: p.payCents, carryOutCents: p.carryOutCents,
      bills: Object.fromEntries(
        Object.entries(p.bills).map(([k, v]) => [k, v as number])),
    })),
  };
});

// ────────────────────────────────────────────────────────────── 封账

registerHandler(FinalizeDay, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof FinalizeDay.input._type>) => {
  const date = await resolveDate(tx, ctx.locationId, input.businessDate);
  const dc = await ensureDayClose(tx, ctx, date);
  assertNotClosed(dc.status, date);

  const [row] = await tx<{
    counted: number | null; variance: number | null; reason: string | null;
    card_variance: number | null; card_reason: string | null;
    opening: number; closing: number;
  }[]>`
    select counted_cash_cents as counted, cash_variance_cents as variance,
           cash_variance_reason as reason,
           card_variance_cents as card_variance, card_variance_reason as card_reason,
           opening_float_cents as opening, closing_float_cents as closing
    from day_closes where location_id = ${ctx.locationId} and business_date = ${date}`;

  if (row?.counted === null || row?.counted === undefined) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: { businessDate: date, reason: '还没点钞。「封了但没数」是最没用的一种日结' },
    });
  }

  const money = await loadDayMoney(tx, ctx.locationId, date);

  if (money.openTicketCount > 0 && !input.force) {
    throw new AppError(ERROR_CODES.OPEN_TICKETS_REMAIN, {
      details: { businessDate: date, openTickets: money.openTicketCount },
    });
  }

  // 点钞之后又有人改了单，差异要重算 —— 不重算就会封进一个过期的数
  const cash = reconcileCash(toReconcileInput(money, row.opening, row.closing, row.counted));
  if (cash.needsReason && !row.reason) {
    throw new AppError(ERROR_CODES.VARIANCE_REASON_REQUIRED, {
      details: { businessDate: date, thresholdCents: VARIANCE_REASON_THRESHOLD_CENTS },
    });
  }
  if (row.card_variance !== null && row.card_variance !== 0 && !row.card_reason) {
    throw new AppError(ERROR_CODES.VARIANCE_REASON_REQUIRED, {
      details: { businessDate: date, which: 'card' },
    });
  }

  await tx`update day_closes set
      status = 'closed',
      expected_cash_cents = ${cash.expectedCents},
      cash_variance_cents = ${cash.varianceCents},
      gross_cents = ${money.grossCents},
      discount_cents = ${money.discountCents},
      net_cents = ${money.netCents},
      tax_cents = ${money.taxCents},
      tip_cash_cents = ${money.tipCashCents},
      tip_card_cents = ${money.tipCardCents},
      note = coalesce(${input.note ?? null}, note),
      closed_by = ${ctx.membershipId},
      closed_at = now()
    where location_id = ${ctx.locationId} and business_date = ${date}`;

  audit({
    entityType: 'day_close', entityId: dc.id,
    after: {
      businessDate: date, status: 'closed',
      forcedWithOpenTickets: money.openTicketCount > 0,
    },
  });

  return {
    businessDate: date,
    grossCents: money.grossCents,
    netCents: money.netCents,
    tipCashCents: money.tipCashCents,
    tipCardCents: money.tipCardCents,
    cashVarianceCents: cash.varianceCents,
    cardVarianceCents: row.card_variance ?? 0,
  };
});

registerHandler(ReopenDay, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof ReopenDay.input._type>) => {
  const [row] = await tx<{ id: string; status: string }[]>`
    update day_closes set status = 'counted', closed_at = null, closed_by = null
    where location_id = ${ctx.locationId} and business_date = ${input.businessDate}
      and status = 'closed'
    returning id, status`;
  if (!row) {
    throw new AppError(ERROR_CODES.NOT_FOUND, {
      details: { businessDate: input.businessDate, reason: '这一天没有封账记录' },
    });
  }
  audit({
    entityType: 'day_close', entityId: row.id,
    before: { status: 'closed' },
    after: { businessDate: input.businessDate, status: 'counted', reason: input.reason },
  });
  return { businessDate: input.businessDate, status: 'counted' as const };
});

// ────────────────────────────────────────────────────────── 断档的日子（0032）

/**
 * 把一个没记的营业日说清楚。
 *
 * 这个命令服务的是一件很朴素的事：**门店会有整天不用系统的时候**，
 * 而第二天回来的时候，那一天不能就那么空着 ——
 * 空着的那天会在报表里静默消失，把周合计拉低而没人看得出来。
 *
 * 三条 guard，每一条都拦着一种「把假数据写进历史」的路：
 *
 *   1. 那天已经有真实工单 → 拒。真实数据比事后的概括可信得多。
 *   2. 那天已经封账       → 拒。要改先 reopen，留痕。
 *   3. 日期在未来         → 拒。「明天没营业」不是记录，是计划。
 */
registerHandler(MarkGapDay, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof MarkGapDay.input._type>) => {
  const today = await resolveDate(tx, ctx.locationId);
  if (input.businessDate > today) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: {
        businessDate: input.businessDate,
        reason: '不能标记还没到的日子 —— 那是计划，不是记录',
      },
    });
  }

  // ⭐ 有真实工单就不许盖。哪怕只有一张作废单也算 ——
  // 那天有人操作过系统，「没营业」这句话就是假的。
  const [real] = await tx<{ n: number }[]>`
    select count(*)::int as n from tickets
    where location_id = ${ctx.locationId} and business_date = ${input.businessDate}`;
  if ((real?.n ?? 0) > 0) {
    throw new AppError(ERROR_CODES.DAY_HAS_REAL_RECORDS, {
      details: {
        businessDate: input.businessDate, ticketCount: real!.n,
        hint: '这天系统里有单。要么把它正常封账，要么先把那些单作废',
      },
    });
  }

  const dc = await ensureDayClose(tx, ctx, input.businessDate);
  assertNotClosed(dc.status, input.businessDate);

  if (input.mark === 'summary_only' && !input.summary) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: {
        businessDate: input.businessDate,
        reason: '补总数就得真的给个数，不然这条记录比空白更坏',
      },
    });
  }

  const s = input.mark === 'summary_only' ? input.summary! : null;
  if (s && s.cashCents + s.cardCents > s.grossCents) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: {
        businessDate: input.businessDate,
        reason: '现金加刷卡超过了总额，八成是敲错了一位',
      },
    });
  }

  await tx`update day_closes set
      status                  = ${input.mark},
      backfill_gross_cents    = ${s?.grossCents ?? null},
      backfill_cash_cents     = ${s?.cashCents ?? null},
      backfill_card_cents     = ${s?.cardCents ?? null},
      backfill_tip_cash_cents = ${s?.tipCashCents ?? null},
      backfill_tip_card_cents = ${s?.tipCardCents ?? null},
      gap_note                = ${input.note ?? null},
      marked_by               = ${ctx.membershipId},
      marked_at               = now()
    where location_id = ${ctx.locationId} and business_date = ${input.businessDate}`;

  // 审计留动作不留金额（宪法第 17 条）：谁标的、标成什么、几点标的
  audit({
    entityType: 'day_close', entityId: dc.id,
    before: { status: dc.status },
    after: {
      businessDate: input.businessDate, status: input.mark,
      note: input.note ?? null,
      // ⭐ 留一条痕：这天的提成永远是空的。以后有人问「八月那周工资怎么算的」，
      //    答案得在审计里找得到，而不是靠人回忆
      earningsStillMissing: input.mark !== 'no_business',
    },
  });

  return {
    businessDate: input.businessDate,
    status: input.mark,
    // 没营业的天本来就没有提成可算，那不叫「缺」；另外两种是真的缺
    earningsStillMissing: input.mark !== 'no_business',
  };
});
