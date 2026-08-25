/**
 * 工单命令实现。
 *
 * 小费分配调 packages/payroll 的纯函数 —— 唯一实现（宪法第 2 条）。
 * 结账时把 basis 快照落库，之后改规则也不影响这一单（策略版本化）。
 */

import type postgres from 'postgres';
import {
  TicketOpen, TicketAddItem, TicketClose, TicketVoid,
  TicketGroup, TicketUngroup, TicketCloseGroup,
  AppError, ERROR_CODES, type CommandContext, pickText
} from '@gf/contracts';
import {
  allocateTip, explainAllocation, DEFAULT_TIP_POLICY,
  largestRemainderSplit, distributeBuckets,
  TipPolicyError, type ServiceLine, type TipPolicy,
} from '@gf/payroll';
import { businessDateOf, } from '@gf/scheduling';
import { jsonb } from '@gf/db';
import { registerHandler, type HandlerArgs } from '../bus';
import { redeemForTicket } from './giftcard';
import {
  loadPlans, writeCommissionEarnings, writeTipEarning, assertDayOpen,
  type LoadedPlans, type TicketRevenueRow,
} from '../money';

async function bizDate(tx: postgres.TransactionSql, locationId: string): Promise<string> {
  const [loc] = await tx<{ tz: string; cutoff: string }[]>`
    select timezone as tz, business_day_cutoff::text as cutoff
    from locations where id = ${locationId}`;
  if (!loc) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'location' } });
  return businessDateOf(new Date(), loc.tz, loc.cutoff);
}

async function loadTipPolicy(
  tx: postgres.TransactionSql, locationId: string,
): Promise<{ policy: TipPolicy; version: number }> {
  const [row] = await tx<{ config: Record<string, unknown>; version: number }[]>`
    select config, version from tip_policies
    where location_id = ${locationId} order by version desc limit 1`;
  if (!row) return { policy: DEFAULT_TIP_POLICY, version: 0 };

  const c = row.config as {
    basis?: TipPolicy['basis'];
    level_weights_bp?: Record<string, number>;
    role_weights_bp?: { primary: number; assistant: number };
    tip_out?: Array<{ from_role: 'primary'; to_role: 'assistant'; bp: number }>;
    remainder_to?: TipPolicy['remainderTo'];
    house_cut_bp?: number;
  };

  // ⚠️ 库里存着非 0 的 house_cut 也不放行 —— 只在 UI 挡是不够的，
  // 数据可能是迁移、脚本或早期版本写进去的（05 §2.4）
  if ((c.house_cut_bp ?? 0) !== 0) {
    throw new AppError(ERROR_CODES.HOUSE_CUT_FORBIDDEN, {
      details: { reason: '联邦 FLSA 禁止雇主/经理占有小费' },
    });
  }

  return {
    version: row.version,
    policy: {
      basis: c.basis ?? DEFAULT_TIP_POLICY.basis,
      levelWeightsBp: c.level_weights_bp ?? {},
      roleWeightsBp: c.role_weights_bp ?? DEFAULT_TIP_POLICY.roleWeightsBp,
      tipOut: (c.tip_out ?? []).map((t) => ({
        fromRole: t.from_role, toRole: t.to_role, bp: t.bp,
      })),
      remainderTo: c.remainder_to ?? DEFAULT_TIP_POLICY.remainderTo,
      houseCutBp: 0,
    },
  };
}

async function recalcTotals(
  tx: postgres.TransactionSql, ticketId: string,
): Promise<number> {
  const [row] = await tx<{ subtotal: number }[]>`
    select coalesce(sum(total_cents), 0)::int as subtotal
    from ticket_items where ticket_id = ${ticketId}`;
  const subtotal = row?.subtotal ?? 0;
  await tx`update tickets set subtotal_cents = ${subtotal}, total_cents = ${subtotal}
           where id = ${ticketId}`;
  return subtotal;
}

// ─────────────────────────────────────────────────────────────────── 开单

registerHandler(TicketOpen, async ({ input, ctx, tx, audit, emit }: HandlerArgs<
  typeof TicketOpen.input._type>) => {
  const date = await bizDate(tx, ctx.locationId);
  await assertDayOpen(tx, ctx.locationId, date);

  const svcIds = [...new Set(input.items.map((i) => i.serviceId))];
  const svcs = await tx<{
    id: string; name: unknown; duration_min: number; base_price_cents: number;
  }[]>`select id, name, duration_min, base_price_cents from services
       where id = any(${svcIds}) and active = true`;
  const byId = new Map(svcs.map((s) => [s.id, s]));

  const [ticket] = await tx<{ id: string }[]>`
    insert into tickets
      (org_id, location_id, business_date, customer_id, walk_in_name, appointment_id,
       group_id, status, opened_by)
    values (${ctx.orgId}, ${ctx.locationId}, ${date}, ${input.customerId},
            ${input.walkInName ?? null}, ${input.appointmentId ?? null},
            ${input.groupId ?? null}, 'in_service', ${ctx.membershipId})
    returning id`;

  for (const [seq, it] of input.items.entries()) {
    const svc = byId.get(it.serviceId);
    if (!svc) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { serviceId: it.serviceId } });
    const price = it.priceCentsOverride ?? svc.base_price_cents;
    const mins = it.minutes ?? svc.duration_min;

    const [item] = await tx<{ id: string }[]>`
      insert into ticket_items
        (org_id, location_id, ticket_id, kind, service_id, name_snapshot,
         qty, unit_price_cents, total_cents, duration_min, seq)
      values (${ctx.orgId}, ${ctx.locationId}, ${ticket!.id}, 'service', ${it.serviceId},
              ${pickText(svc.name, ctx.locale)}, 1, ${price}, ${price}, ${mins}, ${seq})
      returning id`;

    await tx`insert into ticket_item_staff (org_id, ticket_item_id, membership_id, role, minutes)
             values (${ctx.orgId}, ${item!.id}, ${it.membershipId}, 'primary', ${mins})`;
  }

  const subtotal = await recalcTotals(tx, ticket!.id);
  audit({ entityType: 'ticket', entityId: ticket!.id,
          after: { itemCount: input.items.length, businessDate: date } });

  // ⭐ 这就是技师手机响铃的那一下（01 §6）。
  // 一张单可能派给两个人（双技师/接力），各发各的 —— 技师端只对自己那条响。
  for (const mid of new Set(input.items.map((i) => i.membershipId))) {
    emit({ type: 'ticket.assigned', entityId: ticket!.id, membershipId: mid, businessDate: date });
  }
  return { ticketId: ticket!.id, subtotalCents: subtotal };
});

// ─────────────────────────────────────────────────────────────────── 加钟/加项

registerHandler(TicketAddItem, async ({ input, ctx, tx, audit, emit }: HandlerArgs<
  typeof TicketAddItem.input._type>) => {
  const [t] = await tx<{ status: string }[]>`
    select status from tickets where id = ${input.ticketId}`;
  if (!t) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'ticket' } });
  // 已结账的单不能再加项 —— 要改就得先作废重开，否则金额和已发的小费对不上
  if (t.status === 'closed' || t.status === 'voided') {
    throw new AppError(ERROR_CODES.TICKET_ALREADY_CLOSED, { details: { status: t.status } });
  }

  const [svc] = await tx<{ name: unknown; duration_min: number; base_price_cents: number }[]>`
    select name, duration_min, base_price_cents from services
    where id = ${input.serviceId} and active = true`;
  if (!svc) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { serviceId: input.serviceId } });

  const price = input.priceCentsOverride ?? svc.base_price_cents;
  const mins = input.minutes ?? svc.duration_min;

  const [maxSeq] = await tx<{ n: number }[]>`
    select coalesce(max(seq), -1)::int as n from ticket_items where ticket_id = ${input.ticketId}`;

  const [item] = await tx<{ id: string }[]>`
    insert into ticket_items
      (org_id, location_id, ticket_id, kind, service_id, name_snapshot,
       qty, unit_price_cents, total_cents, duration_min, seq)
    values (${ctx.orgId}, ${ctx.locationId}, ${input.ticketId}, ${input.kind},
            ${input.serviceId}, ${pickText(svc.name, ctx.locale)}, 1, ${price}, ${price}, ${mins},
            ${(maxSeq?.n ?? -1) + 1})
    returning id`;

  await tx`insert into ticket_item_staff (org_id, ticket_item_id, membership_id, role, minutes)
           values (${ctx.orgId}, ${item!.id}, ${input.membershipId}, 'primary', ${mins})`;

  const subtotal = await recalcTotals(tx, input.ticketId);
  audit({ entityType: 'ticket', entityId: input.ticketId,
          after: { addedItemId: item!.id, kind: input.kind } });
  // 加钟/加项对被加的那个技师来说也是一次派单（可能是另一个人来接手）
  emit({ type: 'ticket.assigned', entityId: input.ticketId, membershipId: input.membershipId });
  return { ticketItemId: item!.id, subtotalCents: subtotal };
});

// ─────────────────────────────────────────────────────────────────── 结账

/** 一张单在结账那一刻需要知道的一切 */
interface TicketForClose {
  id: string;
  subtotalCents: number;
  businessDate: string;
  groupId: string | null;
}

async function loadTicketForClose(
  tx: postgres.TransactionSql, ticketId: string,
): Promise<TicketForClose> {
  const [t] = await tx<{
    id: string; status: string; subtotal: number; business_date: string; group_id: string | null;
  }[]>`
    select id, status, subtotal_cents as subtotal,
           business_date::text as business_date, group_id
    from tickets where id = ${ticketId}`;
  if (!t) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'ticket', ticketId } });
  if (t.status === 'closed' || t.status === 'voided') {
    throw new AppError(ERROR_CODES.TICKET_ALREADY_CLOSED, { details: { ticketId, status: t.status } });
  }
  return {
    id: t.id, subtotalCents: t.subtotal,
    businessDate: t.business_date, groupId: t.group_id,
  };
}

/** 结账用到的收款行。amountCents 含小费 —— 与刷卡机小票上的数一致 */
interface PaymentIn {
  method: 'cash' | 'card' | 'external' | 'gift_card';
  amountCents: number;
  tipCents: number;
  tenderedCents?: number | undefined;
  changeCents: number;
  keepChange: boolean;
  /** `method = 'gift_card'` 时二选一（批 8 收尾） */
  giftCardId?: string | undefined;
  giftCardCode?: string | undefined;
}

export interface CloseOutcome {
  ticketId: string;
  totalCents: number;
  tipCents: number;
  allocations: Array<{
    membershipId: string; name: string; amountCents: number;
    source: 'cash' | 'card'; explain: string;
  }>;
  earnings: Array<{ membershipId: string; commissionCents: number; baseCents: number; explain: string }>;
}

/**
 * 结掉一张单 —— 单独结账和组单合并结账走的是同一条路。
 *
 * 顺序有讲究：先校对金额，再分小费，再算提成，最后才落收款与状态。
 * 任何一步抛错整个事务回滚，绝不会出现「钱记了但小费没分」的中间态。
 *
 * @param groupPaymentId 组单合并收款时，同一次收款在每张单上各留一行，共用这个 id
 */
async function closeOneTicket(args: {
  tx: postgres.TransactionSql;
  ctx: CommandContext;
  ticket: TicketForClose;
  payments: readonly PaymentIn[];
  discountCents: number;
  loaded: LoadedPlans;
  groupPaymentId?: string;
  payerTicketId?: string;
}): Promise<CloseOutcome> {
  const { tx, ctx, ticket, payments, discountCents, loaded } = args;

  const cashTip = payments.filter((p) => p.method === 'cash').reduce((s, p) => s + p.tipCents, 0);
  const cardTip = payments.filter((p) => p.method !== 'cash').reduce((s, p) => s + p.tipCents, 0);
  const totalTip = cashTip + cardTip;
  const paidTotal = payments.reduce((s, p) => s + p.amountCents, 0);
  const shouldBe = ticket.subtotalCents - discountCents + totalTip;

  // 收多了收少了当场拦下。Phase 1a 没有这道校验，因为一张单的金额是前端
  // 照着 subtotal 算出来的；组单拆分之后这个假设不再成立，
  // 而「某个人的单被静默记成了别的金额」是查都没法查的错。
  if (paidTotal !== shouldBe) {
    throw new AppError(ERROR_CODES.PAYMENT_MISMATCH, {
      details: {
        ticketId: ticket.id,
        expected: shouldBe, received: paidTotal,
        hint: '收款额 = 服务金额 − 折扣 + 小费',
      },
    });
  }

  // ── 小费分配（唯一实现在 @gf/payroll）────────────────────────────────────
  const lines = await tx<{
    item_id: string; name: string; total_cents: number; item_discount_cents: number;
    kind: string; category_id: string | null;
    membership_id: string; role: string; minutes: number;
    staff_name: unknown; level_key: string | null;
  }[]>`
    select ti.id as item_id, ti.name_snapshot as name, ti.total_cents,
           ti.discount_cents as item_discount_cents, ti.kind, s.category_id,
           tis.membership_id, tis.role, tis.minutes,
           sp.display_name as staff_name, sl.key as level_key
    from ticket_items ti
    join ticket_item_staff tis on tis.ticket_item_id = ti.id
    left join services s on s.id = ti.service_id
    left join staff_profiles sp on sp.membership_id = tis.membership_id
    left join staff_levels sl on sl.id = sp.level_id
    where ti.ticket_id = ${ticket.id}`;

  const serviceLines: ServiceLine[] = lines.map((l) => ({
    ticketItemId: l.item_id,
    membershipId: l.membership_id,
    name: pickText(l.staff_name, ctx.locale),
    role: l.role === 'assistant' ? 'assistant' : 'primary',
    minutes: l.minutes,
    amountCents: l.total_cents,
    levelKey: l.level_key,
  }));

  const { policy, version } = await loadTipPolicy(tx, ctx.locationId);

  const out: CloseOutcome['allocations'] = [];
  try {
    // 现金小费与刷卡小费分开算：现金当天发，刷卡进工资（00 §3.1）
    for (const [src, amount] of [['cash', cashTip], ['card', cardTip]] as const) {
      if (amount <= 0) continue;
      const r = allocateTip(amount, serviceLines, policy);
      for (const a of r.allocations) {
        await tx`insert into tip_allocations
          (org_id, location_id, ticket_id, membership_id, amount_cents, basis, source, policy_version)
          values (${ctx.orgId}, ${ctx.locationId}, ${ticket.id}, ${a.membershipId},
                  ${a.amountCents}, ${jsonb(a.basis)}::jsonb, ${src}, ${version})`;
        await writeTipEarning({
          tx, ctx, ticketId: ticket.id, businessDate: ticket.businessDate,
          membershipId: a.membershipId, amountCents: a.amountCents,
          source: src, basis: a.basis, policyVersion: version,
        });
        out.push({
          membershipId: a.membershipId, name: a.name, amountCents: a.amountCents,
          source: src, explain: explainAllocation(a),
        });
      }
    }
  } catch (e) {
    if (e instanceof TipPolicyError) {
      throw new AppError(ERROR_CODES.HOUSE_CUT_FORBIDDEN, { details: { message: e.message } });
    }
    throw e;
  }

  /*
   * ── 礼品卡先核销（批 8 收尾）────────────────────────────────────────
   *
   * ⚠️ **在写 payments 之前做，而且在同一个事务里。**
   * 反过来的话，「payments 记了但卡没扣」会让一张卡被无限次使用 ——
   * 而账本上一条记录都没有，对账时也发现不了。
   *
   * 核销失败（卡空了、过期了、是别家店的）就整笔结账回滚：
   * 让前台改成实际能扣的金额重来，而不是悄悄少扣 —— 后者会让
   * 单据金额和实收金额对不上，那正是日结要发现的东西。
   */
  let giftCardCommissionCut = 0;
  for (const p of payments) {
    if (p.method !== 'gift_card') continue;
    const r = await redeemForTicket(tx, ctx, {
      ticketId: ticket.id, dueCents: p.amountCents,
      ...(p.giftCardId ? { giftCardId: p.giftCardId } : {}),
      ...(p.giftCardCode ? { code: p.giftCardCode } : {}),
    });
    /*
     * ⭐ 提成基数按老板设的口径打折。
     *
     * `commission_basis = 'sale'` 时店家只收到售价那部分，
     * 差额在提成上的效果**和一笔折扣完全一样** —— 所以直接并进
     * `ticketDiscountCents`，复用引擎已经写好的「整单折扣按项摊」逻辑，
     * 不在提成引擎里再开一个礼品卡分支。
     */
    giftCardCommissionCut += r.appliedCents - r.commissionBaseCents;
  }

  // ── 提成落账 ──────────────────────────────────────────────────────────────
  const earnings = await writeCommissionEarnings({
    tx, ctx, ticketId: ticket.id, businessDate: ticket.businessDate,
    rows: lines as unknown as TicketRevenueRow[],
    ticketDiscountCents: discountCents + giftCardCommissionCut,
    loaded,
  });

  // ── 收款 ──────────────────────────────────────────────────────────────────
  for (const p of payments) {
    await tx`insert into payments
      (org_id, location_id, ticket_id, method, amount_cents, tip_cents,
       tendered_cents, change_cents, keep_change, group_payment_id, payer_ticket_id, taken_by)
      values (${ctx.orgId}, ${ctx.locationId}, ${ticket.id}, ${p.method},
              ${p.amountCents}, ${p.tipCents},
              ${p.tenderedCents ?? null}, ${p.changeCents}, ${p.keepChange},
              ${args.groupPaymentId ?? null}, ${args.payerTicketId ?? null},
              ${ctx.membershipId})`;
  }

  await tx`update tickets set
      status = 'closed', closed_at = now(), closed_by = ${ctx.membershipId},
      discount_cents = ${discountCents},
      tip_cents = ${totalTip},
      total_cents = ${paidTotal},
      tip_policy_version = ${version}
    where id = ${ticket.id}`;

  return { ticketId: ticket.id, totalCents: paidTotal, tipCents: totalTip, allocations: out, earnings };
}

registerHandler(TicketClose, async ({ input, ctx, tx, audit, emit }: HandlerArgs<
  typeof TicketClose.input._type>) => {
  const ticket = await loadTicketForClose(tx, input.ticketId);
  await assertDayOpen(tx, ctx.locationId, ticket.businessDate);
  const loaded = await loadPlans(tx, ctx.locationId);

  const r = await closeOneTicket({
    tx, ctx, ticket, payments: input.payments,
    discountCents: input.discountCents, loaded,
  });

  // 审计留动作不留金额：只记「结了、几种支付方式、分给几个人」
  audit({
    entityType: 'ticket', entityId: input.ticketId,
    after: {
      status: 'closed',
      methods: input.payments.map((p) => p.method),
      keepChange: input.payments.some((p) => p.keepChange),
      allocationCount: r.allocations.length,
    },
  });

  // 技师的「今日收入」要跟着跳，前台的在做的单要消失
  emit({ type: 'ticket.changed', entityId: input.ticketId, businessDate: ticket.businessDate });

  return {
    ticketId: r.ticketId, totalCents: r.totalCents,
    tipCents: r.tipCents, allocations: r.allocations,
  };
});

// ─────────────────────────────────────────────────────────────────── 组单

registerHandler(TicketGroup, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof TicketGroup.input._type>) => {
  const date = await bizDate(tx, ctx.locationId);

  let groupId = input.groupId;
  if (!groupId) {
    const [g] = await tx<{ id: string }[]>`
      insert into ticket_groups (org_id, location_id, business_date, label, created_by)
      values (${ctx.orgId}, ${ctx.locationId}, ${date}, ${input.label ?? null}, ${ctx.membershipId})
      returning id`;
    groupId = g!.id;
  } else if (input.label) {
    await tx`update ticket_groups set label = ${input.label} where id = ${groupId}`;
  }

  // 已结账的单不能改组：那会让「谁付的钱」这条线索指向一个当时不存在的组
  const rows = await tx<{ id: string }[]>`
    update tickets set group_id = ${groupId}
    where id = any(${input.ticketIds}) and status not in ('closed','voided')
    returning id`;

  if (rows.length === 0) {
    throw new AppError(ERROR_CODES.NOT_FOUND, {
      details: { reason: '这些单要么不存在，要么已经结账了' },
    });
  }

  audit({ entityType: 'ticket_group', entityId: groupId,
          after: { ticketIds: rows.map((r) => r.id), label: input.label ?? null } });
  return { groupId, ticketCount: rows.length };
});

registerHandler(TicketUngroup, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof TicketUngroup.input._type>) => {
  const [row] = await tx<{ group_id: string | null }[]>`
    update tickets set group_id = null
    where id = ${input.ticketId} and status not in ('closed','voided')
    returning group_id`;
  if (!row) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'ticket' } });
  audit({ entityType: 'ticket', entityId: input.ticketId, after: { groupId: null } });
  return { ticketId: input.ticketId };
});

/**
 * ⭐ 一个人付掉一组单。
 *
 * 钱按各单的服务净额占比摊回去（最大余额法，分毫不差），
 * 然后每张单照常走一遍单独结账的逻辑 —— 提成、小费分配、报表口径全不变。
 * 合并的只是「谁掏的钱」这一件事。
 */
registerHandler(TicketCloseGroup, async ({ input, ctx, tx, audit, emit }: HandlerArgs<
  typeof TicketCloseGroup.input._type>) => {
  const tickets: TicketForClose[] = [];
  for (const id of input.ticketIds) {
    const t = await loadTicketForClose(tx, id);
    if (t.groupId !== input.groupId) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
        details: { ticketId: id, reason: '这张单不属于这一组' },
      });
    }
    tickets.push(t);
  }
  await assertDayOpen(tx, ctx.locationId, tickets[0]!.businessDate);

  const subtotals = tickets.map((t) => t.subtotalCents);
  const subtotalSum = subtotals.reduce((a, b) => a + b, 0);

  const tipSum = input.payments.reduce((s, p) => s + p.tipCents, 0);
  const paidSum = input.payments.reduce((s, p) => s + p.amountCents, 0);
  if (paidSum !== subtotalSum - input.discountCents + tipSum) {
    throw new AppError(ERROR_CODES.PAYMENT_MISMATCH, {
      details: {
        expected: subtotalSum - input.discountCents + tipSum, received: paidSum,
        hint: '整组收款额 = 各单服务金额合计 − 折扣 + 小费',
      },
    });
  }

  // ── 拆分：每张单的钱要对，每种支付方式的合计也要对 ───────────────────────
  //
  // 折扣按各单金额摊（最大余额法），于是每张单的服务净额是确定的；
  // 小费同理。然后用 distributeBuckets 把实际收到的现金/刷卡额**填**进
  // 各单的需求里 —— 按比例摊会在「单」和「支付方式」之间差出一分，
  // 而支付方式那一边差一分，晚上点钞就对不上。
  const discounts = largestRemainderSplit(input.discountCents, subtotals);
  const nets = tickets.map((t, i) => t.subtotalCents - (discounts[i] ?? 0));
  const tipShares = largestRemainderSplit(tipSum, subtotals);

  const netBuckets = input.payments.map((p) => p.amountCents - p.tipCents);
  const tipBuckets = input.payments.map((p) => p.tipCents);
  const netFill = distributeBuckets(nets, netBuckets);
  const tipFill = distributeBuckets(tipShares, tipBuckets);

  const groupPaymentId = crypto.randomUUID();
  const loaded = await loadPlans(tx, ctx.locationId);

  const results: CloseOutcome[] = [];
  for (const [i, t] of tickets.entries()) {
    const lines: PaymentIn[] = input.payments
      .map((p, j) => ({
        method: p.method,
        amountCents: (netFill[i]![j] ?? 0) + (tipFill[i]![j] ?? 0),
        tipCents: tipFill[i]![j] ?? 0,
        // 实收/找零只属于真正掏钱的那一次动作，不往每张单上复制 ——
        // 复制的话日结会把同一笔实收数好几遍
        tenderedCents: undefined,
        changeCents: 0,
        keepChange: p.keepChange,
      }))
      .filter((p) => p.amountCents > 0 || p.tipCents > 0);

    results.push(await closeOneTicket({
      tx, ctx, ticket: t,
      // 整组里可能有人这一单是 0 元（全被折扣抵掉），照样要留一行收款
      payments: lines.length > 0 ? lines : [{
        method: input.payments[0]!.method, amountCents: 0, tipCents: 0,
        tenderedCents: undefined, changeCents: 0, keepChange: false,
      }],
      discountCents: discounts[i] ?? 0, loaded,
      groupPaymentId,
      ...(input.payerTicketId ? { payerTicketId: input.payerTicketId } : {}),
    }));
  }

  audit({
    entityType: 'ticket_group', entityId: input.groupId,
    after: {
      status: 'closed',
      ticketCount: tickets.length,
      methods: input.payments.map((p) => p.method),
      payerTicketId: input.payerTicketId ?? null,
    },
  });

  for (const r of results) {
    emit({ type: 'ticket.changed', entityId: r.ticketId, businessDate: tickets[0]!.businessDate });
  }

  return {
    groupId: input.groupId,
    tickets: results.map((r) => ({
      ticketId: r.ticketId, totalCents: r.totalCents, tipCents: r.tipCents,
    })),
    allocations: results.flatMap((r) => r.allocations),
  };
});

// ─────────────────────────────────────────────────────────────────── 作废

registerHandler(TicketVoid, async ({ input, ctx, tx, audit, emit }: HandlerArgs<
  typeof TicketVoid.input._type>) => {
  const [t] = await tx<{ status: string; business_date: string }[]>`
    select status, business_date::text as business_date from tickets where id = ${input.ticketId}`;
  if (!t) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'ticket' } });
  if (t.status === 'voided') {
    throw new AppError(ERROR_CODES.ALREADY_CANCELLED, { details: { status: t.status } });
  }
  await assertDayOpen(tx, ctx.locationId, t.business_date);

  // ⚠️ 冲销，不删除（宪法第 9 条）。
  // 原来这里是 `delete from tip_allocations` —— 两个问题：财务记录不该消失，
  // 而且 0005 已经对 app_user 撤销了那张表的 DELETE 权限，
  // 于是「作废一张已经分过小费的单」在生产上会直接抛权限错。
  // 之所以一直没被撞见：作废通常发生在结账前，那时还没有分配行。
  await tx`update tip_allocations
             set reversed_at = now(), reversed_by = ${ctx.membershipId}
           where ticket_id = ${input.ticketId} and reversed_at is null`;
  await tx`update earnings
             set reversed_at = now(), reversed_by = ${ctx.membershipId}
           where ticket_id = ${input.ticketId} and reversed_at is null`;

  await tx`update tickets set
      status = 'voided', voided_at = now(), voided_by = ${ctx.membershipId},
      void_reason = ${input.reason}, void_note = ${input.note ?? null}
    where id = ${input.ticketId}`;

  audit({
    entityType: 'ticket', entityId: input.ticketId,
    before: { status: t.status },
    after: { status: 'voided', reason: input.reason, note: input.note ?? null },
  });
  emit({ type: 'ticket.changed', entityId: input.ticketId, businessDate: t.business_date });
  return { ticketId: input.ticketId, status: 'voided' as const };
});
