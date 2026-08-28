/**
 * 工单命令实现。
 *
 * 小费分配调 packages/payroll 的纯函数 —— 唯一实现（宪法第 2 条）。
 * 结账时把 basis 快照落库，之后改规则也不影响这一单（策略版本化）。
 */

import type postgres from 'postgres';
import {
  TicketOpen, TicketAddItem, TicketClose, TicketPay, TicketVoid,
  TicketGroup, TicketUngroup, TicketCloseGroup, TicketSendReceipt, TicketRefund,
  AppError, ERROR_CODES, type CommandContext, pickText
} from '@gf/contracts';
import {
  allocateTip, explainAllocation, DEFAULT_TIP_POLICY,
  largestRemainderSplit, distributeBuckets,
  TipPolicyError, type ServiceLine, type TipPolicy,
} from '@gf/payroll';
import { businessDateOf } from '@gf/scheduling';
import { jsonb, smsOptedOut } from '@gf/db';
import { registerHandler, type HandlerArgs } from '../bus';
import { redeemForTicket } from './giftcard';
import { segmentsOf } from '../sms/segments';
import { flushSms } from '../sms/flush';
import { flushEmails } from '../email/flush';
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

  let customerId = input.customerId;
  let walkInName = input.walkInName ?? null;
  let appointmentItemSnapshots: Array<{
    serviceId: string; durationMin: number; priceCents: number;
  }> | null = null;
  if (input.appointmentId) {
    // Lock the appointment before looking for an existing ticket. Without the lock,
    // two different idempotency keys submitted at the same time can both pass the
    // check and turn one arrival into two live tickets.
    const [appointment] = await tx<{
      id: string; customer_id: string | null; walk_in_name: string | null;
      status: string; business_date: string;
    }[]>`
      select id, customer_id, walk_in_name, status,
             business_date::text as business_date
      from appointments
      where id = ${input.appointmentId} and location_id = ${ctx.locationId}
      for update`;
    if (!appointment) {
      throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'appointment' } });
    }
    if (appointment.status === 'cancelled' || appointment.status === 'done') {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
        details: { reason: 'appointment_not_openable', status: appointment.status },
      });
    }
    if (appointment.business_date !== date) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
        details: {
          reason: 'appointment_business_date_mismatch',
          appointmentBusinessDate: appointment.business_date,
          currentBusinessDate: date,
        },
      });
    }
    if (input.customerId && input.customerId !== appointment.customer_id) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
        details: { reason: 'appointment_customer_mismatch' },
      });
    }
    const appointmentItems = await tx<{
      service_id: string; duration_min: number; price_cents_snapshot: number;
    }[]>`
      select service_id, duration_min, price_cents_snapshot from appointment_items
      where appointment_id = ${appointment.id} and status <> 'cancelled'
      order by seq`;
    const expectedServices = appointmentItems.map((item) => item.service_id);
    const receivedServices = input.items.map((item) => item.serviceId);
    if (expectedServices.length !== receivedServices.length
      || expectedServices.some((serviceId, index) => serviceId !== receivedServices[index])) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
        details: { reason: 'appointment_items_mismatch' },
      });
    }
    appointmentItemSnapshots = appointmentItems.map((item) => ({
      serviceId: item.service_id,
      durationMin: item.duration_min,
      priceCents: item.price_cents_snapshot,
    }));
    input.items.forEach((item, index) => {
      const snapshot = appointmentItemSnapshots![index]!;
      if ((item.minutes !== undefined && item.minutes !== snapshot.durationMin)
        || (item.priceCentsOverride !== undefined
          && item.priceCentsOverride !== snapshot.priceCents)) {
        throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
          details: { reason: 'appointment_snapshot_mismatch', itemIndex: index },
        });
      }
    });

    const [existing] = await tx<{ id: string; status: string }[]>`
      select id, status from tickets
      where appointment_id = ${appointment.id} and status <> 'voided'
      limit 1`;
    if (existing) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
        details: { reason: 'appointment_ticket_exists', ticketId: existing.id, status: existing.status },
      });
    }

    // The appointment is authoritative for identity. The desk does not have to
    // copy a customer id out of a display DTO, and cannot accidentally attach the
    // visit to somebody else with the same phone number.
    customerId = appointment.customer_id;
    walkInName = appointment.walk_in_name ?? walkInName;
  }

  const svcIds = [...new Set(input.items.map((i) => i.serviceId))];
  const svcs = await tx<{
    id: string; name: unknown; duration_min: number; base_price_cents: number;
  }[]>`select id, name, duration_min, base_price_cents from services
       where id = any(${svcIds}) and location_id = ${ctx.locationId} and active = true`;
  const byId = new Map(svcs.map((s) => [s.id, s]));

  const staffIds = [...new Set(input.items.map((item) => item.membershipId))];
  const validStaff = await tx<{ membership_id: string }[]>`
    select membership_id from staff_profiles
    where location_id = ${ctx.locationId} and membership_id = any(${staffIds})
      and is_bookable = true`;
  if (validStaff.length !== staffIds.length) {
    throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'staff' } });
  }

  const [ticket] = await tx<{ id: string }[]>`
    insert into tickets
      (org_id, location_id, business_date, customer_id, walk_in_name, appointment_id,
       group_id, status, opened_by)
    values (${ctx.orgId}, ${ctx.locationId}, ${date}, ${customerId},
            ${walkInName}, ${input.appointmentId ?? null},
            ${input.groupId ?? null}, 'in_service', ${ctx.membershipId})
    returning id`;

  const ticketItemIds: string[] = [];
  for (const [seq, it] of input.items.entries()) {
    const svc = byId.get(it.serviceId);
    if (!svc) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { serviceId: it.serviceId } });
    const snapshot = appointmentItemSnapshots?.[seq];
    const price = snapshot?.priceCents ?? it.priceCentsOverride ?? svc.base_price_cents;
    const mins = snapshot?.durationMin ?? it.minutes ?? svc.duration_min;

    const [item] = await tx<{ id: string }[]>`
      insert into ticket_items
        (org_id, location_id, ticket_id, kind, service_id, name_snapshot,
         qty, unit_price_cents, total_cents, duration_min, seq)
      values (${ctx.orgId}, ${ctx.locationId}, ${ticket!.id}, 'service', ${it.serviceId},
              ${pickText(svc.name, ctx.locale)}, 1, ${price}, ${price}, ${mins}, ${seq})
      returning id`;
    ticketItemIds.push(item!.id);

    await tx`insert into ticket_item_staff (org_id, ticket_item_id, membership_id, role, minutes)
             values (${ctx.orgId}, ${item!.id}, ${it.membershipId}, 'primary', ${mins})`;
  }

  const subtotal = await recalcTotals(tx, ticket!.id);
  if (input.appointmentId) {
    await tx`update appointments set status = 'in_service'
             where id = ${input.appointmentId}`;
    await tx`update appointment_items set status = 'in_service'
             where appointment_id = ${input.appointmentId}
               and status not in ('cancelled','completed')`;
  }
  audit({ entityType: 'ticket', entityId: ticket!.id,
          after: { itemCount: input.items.length, businessDate: date } });

  // ⭐ 这就是技师手机响铃的那一下（01 §6）。
  // 一张单可能派给两个人（双技师/接力），各发各的 —— 技师端只对自己那条响。
  for (const mid of new Set(input.items.map((i) => i.membershipId))) {
    emit({ type: 'ticket.assigned', entityId: ticket!.id, membershipId: mid, businessDate: date });
  }
  return { ticketId: ticket!.id, ticketItemIds, subtotalCents: subtotal };
});

// ─────────────────────────────────────────────────────────────────── 加钟/加项

registerHandler(TicketAddItem, async ({ input, ctx, tx, audit, emit }: HandlerArgs<
  typeof TicketAddItem.input._type>) => {
  const [t] = await tx<{ status: string }[]>`
    select status from tickets where id = ${input.ticketId} for update`;
  if (!t) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'ticket' } });
  // 已结账的单不能再加项 —— 要改就得先作废重开，否则金额和已发的小费对不上
  if (t.status === 'closed' || t.status === 'voided') {
    throw new AppError(ERROR_CODES.TICKET_ALREADY_CLOSED, { details: { status: t.status } });
  }

  const [svc] = await tx<{ name: unknown; duration_min: number; base_price_cents: number }[]>`
    select name, duration_min, base_price_cents from services
    where id = ${input.serviceId} and location_id = ${ctx.locationId} and active = true`;
  if (!svc) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { serviceId: input.serviceId } });

  const [staff] = await tx<{ membership_id: string }[]>`
    select membership_id from staff_profiles
    where membership_id = ${input.membershipId} and location_id = ${ctx.locationId}
      and is_bookable = true`;
  if (!staff) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'staff' } });

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
  taxCents?: number;
  surchargeCents?: number;
  tipSplits?: readonly {
    staffMembershipId: string;
    staffName?: string | undefined;
    amountCents: number;
    percentageBp?: number | undefined;
  }[] | undefined;
  loaded: LoadedPlans;
  groupPaymentId?: string;
  payerTicketId?: string;
}): Promise<CloseOutcome> {
  const { tx, ctx, ticket, payments, discountCents, taxCents = 0, surchargeCents = 0, tipSplits, loaded } = args;

  const cashTip = payments.filter((p) => p.method === 'cash').reduce((s, p) => s + p.tipCents, 0);
  const cardTip = payments.filter((p) => p.method !== 'cash').reduce((s, p) => s + p.tipCents, 0);
  const totalTip = cashTip + cardTip;
  const paidTotal = payments.reduce((s, p) => s + p.amountCents, 0);
  const shouldBe = ticket.subtotalCents - discountCents + taxCents + totalTip + surchargeCents;

  // 收多了收少了当场拦下。
  if (paidTotal !== shouldBe) {
    throw new AppError(ERROR_CODES.PAYMENT_MISMATCH, {
      details: {
        ticketId: ticket.id,
        expected: shouldBe, received: paidTotal,
        hint: '收款额 = 服务金额 − 折扣 + 税额 + 小费 + 刷卡费',
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
    if (tipSplits && tipSplits.length > 0) {
      const splitStaffIds = tipSplits.map((split) => split.staffMembershipId);
      if (new Set(splitStaffIds).size !== splitStaffIds.length) {
        throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
          details: { reason: 'duplicate_tip_split_staff' },
        });
      }
      const splitStaff = await tx<{ membership_id: string }[]>`
        select membership_id from staff_profiles
        where location_id = ${ctx.locationId} and membership_id = any(${splitStaffIds})`;
      if (splitStaff.length !== splitStaffIds.length) {
        throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'staff' } });
      }
      const splitTotal = tipSplits.reduce((sum, split) => sum + split.amountCents, 0);
      if (splitTotal !== totalTip) {
        throw new AppError(ERROR_CODES.PAYMENT_MISMATCH, {
          details: { reason: 'tip_split_mismatch', expected: totalTip, received: splitTotal },
        });
      }
      for (const split of tipSplits) {
        if (split.amountCents <= 0) continue;
        const src = cardTip > 0 ? 'card' : 'cash';
        await tx`insert into tip_allocations
          (org_id, location_id, ticket_id, membership_id, amount_cents, basis, source, policy_version)
          values (${ctx.orgId}, ${ctx.locationId}, ${ticket.id}, ${split.staffMembershipId},
                  ${split.amountCents}, ${jsonb({ method: 'custom_split', percentageBp: split.percentageBp })}::jsonb, ${src}, ${version})`;
        await writeTipEarning({
          tx, ctx, ticketId: ticket.id, businessDate: ticket.businessDate,
          membershipId: split.staffMembershipId, amountCents: split.amountCents,
          source: src, basis: { method: 'custom_split' }, policyVersion: version,
        });
        out.push({
          membershipId: split.staffMembershipId,
          name: split.staffName ?? '技师',
          amountCents: split.amountCents,
          source: src,
          explain: `自定义分账 $${(split.amountCents / 100).toFixed(2)}`,
        });
      }
    } else {
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
      tax_cents = ${taxCents},
      surcharge_cents = ${surchargeCents},
      tip_cents = ${totalTip},
      total_cents = ${paidTotal},
      tip_policy_version = ${version}
    where id = ${ticket.id}`;

  // A checked-in appointment remains in walkin_queue until payment succeeds.
  // Advancing it in the same transaction prevents a paid guest from reappearing
  // in the waiting/seated column after the ticket disappears from open tickets.
  await tx`update walkin_queue q set status = 'completed'
           from tickets t
           where t.id = ${ticket.id} and q.appointment_id = t.appointment_id
             and q.status <> 'left'`;
  await tx`update appointments a set status = 'done'
           from tickets t
           where t.id = ${ticket.id} and a.id = t.appointment_id`;

  return { ticketId: ticket.id, totalCents: paidTotal, tipCents: totalTip, allocations: out, earnings };
}

const handleTicketCloseOrPay = async ({ input, ctx, tx, audit, emit }: HandlerArgs<
  typeof TicketClose.input._type>) => {
  const ticket = await loadTicketForClose(tx, input.ticketId);
  await assertDayOpen(tx, ctx.locationId, ticket.businessDate);
  const loaded = await loadPlans(tx, ctx.locationId);

  const r = await closeOneTicket({
    tx, ctx, ticket, payments: input.payments,
    discountCents: input.discountCents,
    taxCents: input.taxCents,
    surchargeCents: input.surchargeCents,
    tipSplits: input.tipSplits,
    loaded,
  });

  // 审计留动作不留金额：只记「结了、几种支付方式、分给几个人」
  audit({
    entityType: 'ticket', entityId: input.ticketId,
    after: {
      status: 'closed',
      methods: input.payments.map((p) => p.method),
      keepChange: input.payments.some((p) => p.keepChange),
      allocationCount: r.allocations.length,
      taxCents: input.taxCents ?? 0,
      surchargeCents: input.surchargeCents ?? 0,
    },
  });

  // 技师的「今日收入」要跟着跳，前台的在做的单要消失
  emit({ type: 'ticket.changed', entityId: input.ticketId, businessDate: ticket.businessDate });

  return {
    ticketId: r.ticketId, totalCents: r.totalCents,
    tipCents: r.tipCents, allocations: r.allocations,
    taxCents: input.taxCents ?? 0,
    subtotalCents: ticket.subtotalCents,
  };
};

registerHandler(TicketClose, handleTicketCloseOrPay);
registerHandler(TicketPay, handleTicketCloseOrPay);

registerHandler(TicketRefund, async ({ input, ctx, tx, audit, emit }: HandlerArgs<
  typeof TicketRefund.input._type>) => {
  const [t] = await tx<{
    id: string; status: string; subtotal_cents: number; discount_cents: number;
    tax_cents: number; surcharge_cents: number; service_charge_cents: number;
    tip_cents: number; total_cents: number; refund_cents: number; business_date: string;
    customer_id: string | null;
  }[]>`
    select id, status, subtotal_cents, discount_cents, tax_cents, surcharge_cents,
           service_charge_cents, tip_cents, total_cents, refund_cents,
           business_date::text as business_date, customer_id
    from tickets
    where id = ${input.ticketId} and location_id = ${ctx.locationId} for update`;

  if (!t) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'ticket' } });
  if (t.status !== 'closed' && t.status !== 'refunded') {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: { reason: 'ticket_not_paid', status: t.status },
    });
  }
  await assertDayOpen(tx, ctx.locationId, t.business_date);

  if (t.refund_cents + input.refundAmountCents > t.total_cents) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, { details: { reason: 'refund_exceeds_total' } });
  }
  if (input.refundTipCents > input.refundAmountCents) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: { reason: 'refund_tip_exceeds_refund' },
    });
  }

  const [already] = await tx<{
    service: number; tax: number; fee: number; tip: number;
    original_cash: number; original_card: number; original_store: number;
  }[]>`
    select
      coalesce(sum(service_cents), 0)::int as service,
      coalesce(sum(tax_cents), 0)::int as tax,
      coalesce(sum(fee_cents), 0)::int as fee,
      coalesce(sum(tip_cents), 0)::int as tip,
      coalesce(sum(cash_cents) filter (where method = 'original_payment'), 0)::int as original_cash,
      coalesce(sum(card_cents) filter (where method = 'original_payment'), 0)::int as original_card,
      coalesce(sum(store_credit_cents) filter (where method = 'original_payment'), 0)::int as original_store
    from ticket_refunds where ticket_id = ${t.id}`;

  const serviceTotal = Math.max(0, t.subtotal_cents - t.discount_cents);
  const feeTotal = t.surcharge_cents + t.service_charge_cents;
  let nonTipLeft = input.refundAmountCents - input.refundTipCents;
  const serviceCents = Math.min(nonTipLeft, Math.max(0, serviceTotal - (already?.service ?? 0)));
  nonTipLeft -= serviceCents;
  const taxCents = Math.min(nonTipLeft, Math.max(0, t.tax_cents - (already?.tax ?? 0)));
  nonTipLeft -= taxCents;
  const feeCents = Math.min(nonTipLeft, Math.max(0, feeTotal - (already?.fee ?? 0)));
  nonTipLeft -= feeCents;
  if (nonTipLeft > 0 || input.refundTipCents > t.tip_cents - (already?.tip ?? 0)) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: { reason: 'refund_components_exceed_remaining' },
    });
  }

  let cashCents = 0;
  let cardCents = 0;
  let storeCreditCents = 0;
  if (input.refundMethod === 'cash') {
    cashCents = input.refundAmountCents;
  } else if (input.refundMethod === 'store_credit') {
    storeCreditCents = input.refundAmountCents;
  } else {
    const [paid] = await tx<{ cash: number; card: number; store: number }[]>`
      select
        coalesce(sum(amount_cents) filter (where method = 'cash'), 0)::int as cash,
        coalesce(sum(amount_cents) filter (where method in ('card','external')), 0)::int as card,
        coalesce(sum(amount_cents) filter (where method = 'gift_card'), 0)::int as store
      from payments where ticket_id = ${t.id}`;
    const remainingChannels = [
      Math.max(0, (paid?.cash ?? 0) - (already?.original_cash ?? 0)),
      Math.max(0, (paid?.card ?? 0) - (already?.original_card ?? 0)),
      Math.max(0, (paid?.store ?? 0) - (already?.original_store ?? 0)),
    ];
    if (remainingChannels.reduce((sum, value) => sum + value, 0) < input.refundAmountCents) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
        details: { reason: 'original_payment_refund_exceeds_channel_balance' },
      });
    }
    [cashCents, cardCents, storeCreditCents] = largestRemainderSplit(
      input.refundAmountCents, remainingChannels, { zeroWeights: 'throw' },
    ) as [number, number, number];
  }

  const [refund] = await tx<{ id: string }[]>`
    insert into ticket_refunds
      (org_id, location_id, ticket_id, business_date, amount_cents,
       service_cents, tax_cents, fee_cents, tip_cents,
       cash_cents, card_cents, store_credit_cents,
       method, reason, notes, refunded_by)
    values
      (${ctx.orgId}, ${ctx.locationId}, ${t.id}, ${t.business_date}, ${input.refundAmountCents},
       ${serviceCents}, ${taxCents}, ${feeCents}, ${input.refundTipCents},
       ${cashCents}, ${cardCents}, ${storeCreditCents},
       ${input.refundMethod}, ${input.reason}, ${input.notes ?? null}, ${ctx.membershipId})
    returning id`;

  if (storeCreditCents > 0 && input.refundMethod === 'store_credit') {
    if (!t.customer_id) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
        details: { reason: 'store_credit_requires_customer' },
      });
    }
    await tx`select id from customers where id = ${t.customer_id} for update`;
    const [credit] = await tx<{ balance: number }[]>`
      select coalesce(sum(amount_cents), 0)::int as balance
      from customer_credit_ledger
      where kind = 'store_credit' and customer_id = ${t.customer_id}`;
    await tx`insert into customer_credit_ledger
      (org_id, location_id, kind, subject_id, customer_id, entry,
       amount_cents, balance_after_cents, ticket_id, reason,
       actor_membership_id, idem_key, meta)
      values (${ctx.orgId}, ${ctx.locationId}, 'store_credit', ${t.customer_id}, ${t.customer_id},
              'refund', ${storeCreditCents}, ${(credit?.balance ?? 0) + storeCreditCents}, ${t.id},
              ${input.reason}, ${ctx.membershipId}, ${`ticket-refund-${refund!.id}`},
              ${jsonb({ refundId: refund!.id })}::jsonb)`;
  }

  if (storeCreditCents > 0 && input.refundMethod === 'original_payment') {
    const giftRows = await tx<{
      gift_card_id: string; redeemed: number; already_refunded: number;
    }[]>`
      with redeemed as (
        select subject_id as gift_card_id, -sum(amount_cents)::int as amount
        from customer_credit_ledger
        where kind = 'gift_card' and ticket_id = ${t.id} and entry = 'redeem'
        group by subject_id
      ), refunded as (
        select subject_id as gift_card_id, sum(amount_cents)::int as amount
        from customer_credit_ledger
        where kind = 'gift_card' and ticket_id = ${t.id} and entry = 'refund'
          and meta->>'ticketRefund' = 'true'
        group by subject_id
      )
      select r.gift_card_id, r.amount as redeemed,
             coalesce(f.amount, 0)::int as already_refunded
      from redeemed r left join refunded f using (gift_card_id)
      order by r.gift_card_id`;
    const remaining = giftRows.map((row) => Math.max(0, row.redeemed - row.already_refunded));
    if (remaining.reduce((sum, value) => sum + value, 0) < storeCreditCents) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
        details: { reason: 'gift_card_refund_source_missing' },
      });
    }
    const giftRefunds = largestRemainderSplit(storeCreditCents, remaining);
    for (const [index, row] of giftRows.entries()) {
      const amount = giftRefunds[index]!;
      if (amount <= 0) continue;
      const [card] = await tx<{ id: string }[]>`
        select id from gift_cards where id = ${row.gift_card_id} for update`;
      if (!card) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'gift_card' } });
      const [balance] = await tx<{ value: number }[]>`
        select coalesce(sum(amount_cents), 0)::int as value
        from customer_credit_ledger where kind = 'gift_card' and subject_id = ${card.id}`;
      const nextBalance = (balance?.value ?? 0) + amount;
      await tx`insert into customer_credit_ledger
        (org_id, location_id, kind, subject_id, entry, amount_cents,
         balance_after_cents, ticket_id, reason, actor_membership_id, idem_key, meta)
        values (${ctx.orgId}, ${ctx.locationId}, 'gift_card', ${card.id}, 'refund', ${amount},
                ${nextBalance}, ${t.id}, ${input.reason}, ${ctx.membershipId},
                ${`ticket-refund-${refund!.id}-${card.id}`},
                ${jsonb({ ticketRefund: true, refundId: refund!.id })}::jsonb)`;
      await tx`update gift_cards set balance_cents = ${nextBalance}, status = 'active', updated_at = now()
               where id = ${card.id}`;
    }
  }

  if (cashCents > 0) {
    await tx`insert into cash_movements
      (org_id, location_id, business_date, kind, amount_cents, note, actor_id)
      values (${ctx.orgId}, ${ctx.locationId}, ${t.business_date}, 'refund', ${-cashCents},
              ${`Refund ${refund!.id}`}, ${ctx.membershipId})`;
  }

  const isFullRefund = t.refund_cents + input.refundAmountCents >= t.total_cents;
  const newStatus = isFullRefund ? 'refunded' : t.status;

  await tx`update tickets set
      refund_cents = refund_cents + ${input.refundAmountCents},
      refund_reason = ${input.reason},
      refund_method = ${input.refundMethod},
      refunded_at = now(),
      refunded_by = ${ctx.membershipId},
      status = ${newStatus}
    where id = ${t.id}`;

  if (isFullRefund) {
    await tx`update tip_allocations
               set reversed_at = now(), reversed_by = ${ctx.membershipId}
             where ticket_id = ${t.id} and reversed_at is null`;
    await tx`update earnings
               set reversed_at = now(), reversed_by = ${ctx.membershipId}
             where ticket_id = ${t.id} and reversed_at is null`;
  } else {
    const cumulativeServiceRefund = (already?.service ?? 0) + serviceCents;
    if (serviceCents > 0) {
      const commissionRows = await tx<{
        membership_id: string; amount: number; base: number;
        refunded_amount: number; refunded_base: number;
      }[]>`
        with original as (
          select membership_id, sum(amount_cents)::int as amount, sum(base_cents)::int as base
          from earnings
          where ticket_id = ${t.id} and kind = 'commission'
            and amount_cents > 0 and reversed_at is null
          group by membership_id
        ), refunded as (
          select membership_id, -sum(amount_cents)::int as amount, -sum(base_cents)::int as base
          from earnings
          where ticket_id = ${t.id} and kind = 'commission'
            and amount_cents < 0 and basis->>'refund' = 'true' and reversed_at is null
          group by membership_id
        )
        select o.membership_id, o.amount, o.base,
               coalesce(r.amount, 0)::int as refunded_amount,
               coalesce(r.base, 0)::int as refunded_base
        from original o left join refunded r using (membership_id)
        order by o.membership_id`;
      const totalCommissionBase = commissionRows.reduce((sum, row) => sum + row.base, 0);
      const targetCommissionBaseTotal = serviceTotal === 0
        ? 0
        : Math.round((totalCommissionBase * cumulativeServiceRefund) / serviceTotal);
      const targetBases = largestRemainderSplit(
        targetCommissionBaseTotal, commissionRows.map((row) => row.base),
      );
      const totalCommission = commissionRows.reduce((sum, row) => sum + row.amount, 0);
      const targetCommissionTotal = serviceTotal === 0
        ? 0
        : Math.round((totalCommission * cumulativeServiceRefund) / serviceTotal);
      const targetAmounts = largestRemainderSplit(
        targetCommissionTotal, commissionRows.map((row) => row.amount),
      );
      for (const [index, row] of commissionRows.entries()) {
        const baseDelta = targetBases[index]! - row.refunded_base;
        const amountDelta = targetAmounts[index]! - row.refunded_amount;
        if (baseDelta === 0 && amountDelta === 0) continue;
        await tx`insert into earnings
          (org_id, location_id, membership_id, business_date, kind,
           amount_cents, base_cents, ticket_id, basis)
          values (${ctx.orgId}, ${ctx.locationId}, ${row.membership_id}, ${t.business_date},
                  'commission', ${-amountDelta}, ${-baseDelta}, ${t.id},
                  ${jsonb({ refund: true, refundId: refund!.id })}::jsonb)`;
      }
    }

    const cumulativeTipRefund = (already?.tip ?? 0) + input.refundTipCents;
    if (input.refundTipCents > 0) {
      const tipRows = await tx<{
        membership_id: string; source: 'cash' | 'card'; amount: number; refunded: number;
        policy_version: number | null;
      }[]>`
        with original as (
          select membership_id, source, sum(amount_cents)::int as amount,
                 max(policy_version)::int as policy_version
          from tip_allocations
          where ticket_id = ${t.id} and amount_cents > 0 and reversed_at is null
          group by membership_id, source
        ), refunded as (
          select membership_id, source, -sum(amount_cents)::int as amount
          from tip_allocations
          where ticket_id = ${t.id} and amount_cents < 0
            and basis->>'refund' = 'true' and reversed_at is null
          group by membership_id, source
        )
        select o.membership_id, o.source, o.amount, coalesce(r.amount, 0)::int as refunded,
               o.policy_version
        from original o left join refunded r using (membership_id, source)
        order by o.membership_id, o.source`;
      const targets = largestRemainderSplit(
        cumulativeTipRefund, tipRows.map((row) => row.amount),
      );
      for (const [index, row] of tipRows.entries()) {
        const delta = targets[index]! - row.refunded;
        if (delta === 0) continue;
        const basis = jsonb({ refund: true, refundId: refund!.id });
        await tx`insert into tip_allocations
          (org_id, location_id, ticket_id, membership_id, amount_cents, basis, source, policy_version)
          values (${ctx.orgId}, ${ctx.locationId}, ${t.id}, ${row.membership_id}, ${-delta},
                  ${basis}::jsonb, ${row.source}, ${row.policy_version})`;
        await tx`insert into earnings
          (org_id, location_id, membership_id, business_date, kind,
           amount_cents, base_cents, ticket_id, basis, plan_version)
          values (${ctx.orgId}, ${ctx.locationId}, ${row.membership_id}, ${t.business_date},
                  ${row.source === 'cash' ? 'tip_cash' : 'tip_card'}, ${-delta}, 0, ${t.id},
                  ${basis}::jsonb, ${row.policy_version})`;
      }
    }
  }

  audit({
    entityType: 'ticket', entityId: t.id,
    after: {
      action: 'refund',
      refundId: refund!.id,
      reason: input.reason,
      refundMethod: input.refundMethod,
      isFullRefund,
    },
  });

  emit({ type: 'ticket.changed', entityId: t.id, businessDate: t.business_date });

  return {
    ticketId: t.id,
    status: newStatus as 'closed' | 'refunded',
    refundedCents: input.refundAmountCents,
    refundMethod: input.refundMethod,
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
  const expected = subtotalSum - input.discountCents + input.taxCents + input.surchargeCents + tipSum;
  if (paidSum !== expected) {
    throw new AppError(ERROR_CODES.PAYMENT_MISMATCH, {
      details: {
        expected, received: paidSum,
        hint: '整组收款额 = 各单服务金额合计 − 折扣 + 税金 + 附加费 + 小费',
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
  const taxes = largestRemainderSplit(input.taxCents, subtotals);
  const surcharges = largestRemainderSplit(input.surchargeCents, subtotals);
  const nets = tickets.map((t, i) => t.subtotalCents - (discounts[i] ?? 0) + (taxes[i] ?? 0) + (surcharges[i] ?? 0));
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
      discountCents: discounts[i] ?? 0, 
      taxCents: taxes[i] ?? 0,
      surchargeCents: surcharges[i] ?? 0,
      loaded,
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
  const [t] = await tx<{
    status: string; business_date: string; appointment_id: string | null;
  }[]>`
    select status, business_date::text as business_date, appointment_id
    from tickets where id = ${input.ticketId}`;
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

  if (t.appointment_id) {
    // Voiding is the escape hatch back to the arrival flow. Keep the queue entry
    // and appointment reusable; the partial unique index will then allow exactly
    // one replacement ticket.
    await tx`update appointments set status = 'checked_in'
             where id = ${t.appointment_id}`;
    await tx`update appointment_items set status = 'booked'
             where appointment_id = ${t.appointment_id} and status <> 'cancelled'`;
    await tx`update walkin_queue set status = 'waiting'
             where appointment_id = ${t.appointment_id} and status <> 'left'`;
  }

  audit({
    entityType: 'ticket', entityId: input.ticketId,
    before: { status: t.status },
    after: { status: 'voided', reason: input.reason, note: input.note ?? null },
  });
  emit({ type: 'ticket.changed', entityId: input.ticketId, businessDate: t.business_date });
  return { ticketId: input.ticketId, status: 'voided' as const };
});

registerHandler(TicketSendReceipt, async ({ input, ctx, tx, audit }) => {
  const [t] = await tx<{
    id: string; total_cents: number; subtotal_cents: number;
    discount_cents: number; tax_cents: number; tip_cents: number;
    customer_id: string | null; walk_in_name: string | null;
    business_date: string;
  }[]>`
    select id, total_cents, subtotal_cents, discount_cents, tax_cents, tip_cents,
           customer_id, walk_in_name, business_date::text as business_date
    from tickets where id = ${input.ticketId} and location_id = ${ctx.locationId}`;

  if (!t) {
    throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'ticket', id: input.ticketId } });
  }

  // 查询工单项目
  const items = await tx<{ name_snapshot: string; total_cents: number }[]>`
    select name_snapshot, total_cents from ticket_items where ticket_id = ${t.id}`;

  let custPhone: string | null = null;
  let custEmail: string | null = null;
  let custName: string = t.walk_in_name ?? 'Valued Guest';

  if (t.customer_id) {
    const [c] = await tx<{ phone_e164: string | null; email: string | null; display_name: string | null }[]>`
      select phone_e164, email, display_name from customers where id = ${t.customer_id}`;
    if (c) {
      custPhone = c.phone_e164;
      custEmail = c.email;
      if (c.display_name) custName = c.display_name;
    }
  }

  const [loc] = await tx<{ name: unknown }[]>`
    select name from locations where id = ${ctx.locationId}`;
  const storeName = pickText(loc?.name, ctx.locale, 'Lotus Nails');

  let outboxId = '';
  let finalDestination = input.destination?.trim() ?? '';

  if (input.channel === 'sms') {
    if (!finalDestination) {
      finalDestination = custPhone ?? '';
    }
    if (!finalDestination) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
        details: { reason: 'missing_destination_phone' },
      });
    }

    const itemsSummary = items.map((i) => `${i.name_snapshot} ($${(i.total_cents / 100).toFixed(2)})`).join(', ');
    const totalFormatted = `$${(t.total_cents / 100).toFixed(2)}`;
    const body = `${storeName}: Thank you ${custName}! Receipt for ${t.business_date}. Items: ${itemsSummary}. Total: ${totalFormatted}.`;

    const segments = segmentsOf(body);
    const isOptedOut = await smsOptedOut(finalDestination);
    const status: 'suppressed' | 'pending' = isOptedOut ? 'suppressed' : 'pending';
    const fromE164 = process.env['TELNYX_SMS_FROM'] ?? '+18005550199';

    const [out] = await tx<{ id: string }[]>`
      insert into sms_outbox (
        org_id, location_id, kind, to_e164, from_e164, body, segments,
        entity_type, entity_id, status, last_error
      ) values (
        ${ctx.orgId}, ${ctx.locationId}, 'direct_message', ${finalDestination},
        ${fromE164}, ${body}, ${segments}, 'ticket', ${t.id},
        ${status}, ${isOptedOut ? 'opted_out' : null}
      )
      returning id`;

    outboxId = out!.id;

    if (status === 'pending') {
      void flushSms({
        orgId: ctx.orgId,
        locationId: ctx.locationId,
        membershipId: ctx.membershipId,
      });
    }
  } else {
    // Email channel
    if (!finalDestination) {
      finalDestination = custEmail ?? '';
    }
    if (!finalDestination) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
        details: { reason: 'missing_destination_email' },
      });
    }

    const subject = `${storeName} Receipt - Ticket #${t.id.slice(0, 8)}`;
    const itemsSummary = items.map((i) => `${i.name_snapshot}: $${(i.total_cents / 100).toFixed(2)}`).join('\n');
    const body = `Thank you for visiting ${storeName}!\n\nDate: ${t.business_date}\n\nItems:\n${itemsSummary}\n\nSubtotal: $${(t.subtotal_cents / 100).toFixed(2)}\nDiscount: -$${(t.discount_cents / 100).toFixed(2)}\nTax: $${(t.tax_cents / 100).toFixed(2)}\nTip: $${(t.tip_cents / 100).toFixed(2)}\nTotal Paid: $${(t.total_cents / 100).toFixed(2)}\n\nWe look forward to seeing you again soon!`;

    const bodyHtml = `<p>Thank you for visiting <strong>${storeName}</strong>!</p><p><strong>Date:</strong> ${t.business_date}</p><pre>${itemsSummary}</pre><p><strong>Total Paid:</strong> $${(t.total_cents / 100).toFixed(2)}</p>`;

    const [out] = await tx<{ id: string }[]>`
      insert into email_outbox (
        org_id, location_id, kind, to_email, subject, body_html, body_text,
        entity_type, entity_id, status
      ) values (
        ${ctx.orgId}, ${ctx.locationId}, 'receipt', ${finalDestination},
        ${subject}, ${bodyHtml}, ${body}, 'ticket', ${t.id}, 'pending'
      )
      returning id`;

    outboxId = out!.id;

    void flushEmails({
      orgId: ctx.orgId,
      locationId: ctx.locationId,
      membershipId: ctx.membershipId,
    });
  }

  audit({
    entityType: 'ticket_receipt',
    entityId: t.id,
    before: {},
    after: {
      channel: input.channel,
      destination: finalDestination,
      outboxId,
    },
  });

  return {
    ticketId: t.id,
    channel: input.channel,
    destination: finalDestination,
    outboxId,
  };
});
