/**
 * 工单命令实现。
 *
 * 小费分配调 packages/payroll 的纯函数 —— 唯一实现（宪法第 2 条）。
 * 结账时把 basis 快照落库，之后改规则也不影响这一单（策略版本化）。
 */

import type postgres from 'postgres';
import {
  TicketOpen, TicketAddItem, TicketClose, TicketPay, TicketVoid,
  TicketGroup, TicketUngroup, TicketCloseGroup, TicketRefund,
  AppError, ERROR_CODES, type CommandContext, pickText
} from '@gf/contracts';
import {
  allocateTip, explainAllocation, DEFAULT_TIP_POLICY,
  largestRemainderSplit, distributeBuckets,
  TipPolicyError, type ServiceLine, type TipPolicy,
} from '@gf/payroll';
import { businessDateOf } from '@gf/scheduling';
import { jsonb } from '@gf/db';
import { registerHandler, type HandlerArgs } from '../bus';
import { redeemForTicket } from './giftcard';
import {
  loadPlans, writeCommissionEarnings, writeTipEarning, assertDayOpen,
  type LoadedPlans, type TicketRevenueRow,
} from '../money';
import { loadCheckoutSettings } from '../queries/settings';
import { locationTaxCents } from '../tax';
import {
  queueLeftReasonOnFullRefund,
  queueLeftReasonOnVoid,
  voidCancelsAppointment,
} from '../ticketLifecycle';

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
    serviceId: string; durationMin: number; priceCents: number; resourceId: string | null;
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
      service_id: string; duration_min: number; price_cents_snapshot: number; resource_id: string | null;
    }[]>`
      select service_id, duration_min, price_cents_snapshot, resource_id from appointment_items
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
      resourceId: item.resource_id,
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
      where appointment_id = ${appointment.id} and status not in ('voided', 'refunded')
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
    id: string; name: unknown; duration_min: number; base_price_cents: number; staff_count: number;
  }[]>`select id, name, duration_min, base_price_cents, staff_count from services
       where id = any(${svcIds}) and location_id = ${ctx.locationId} and active = true`;
  const byId = new Map(svcs.map((s) => [s.id, s]));

  const assignmentsFor = (item: typeof input.items[number]) => item.staffAssignments
    ?? (item.membershipId ? [{ membershipId: item.membershipId, role: 'primary' as const }] : []);
  const staffIds = [...new Set(input.items.flatMap((item) => assignmentsFor(item).map((a) => a.membershipId)))];
  /*
   * ⚠️ 开单**不判技师并发**。
   *
   * 曾经这里按「已开始未完成的 ticket_item 条数」拦过一道，那道闸门有两层错：
   *
   *   1. 按项目计数 —— 一位客人做三个项目、都派给同一位技师时算成并发 3，
   *      而 max_concurrent_appointments 默认是 1。预约层是明确放行这种情况的
   *      （appointment.ts 里同一个 appointment 的项目互不冲突），两层规则
   *      对不上，结果是预约建得进去、单开不出来。
   *   2. 判早了 —— 前台把等位客人的单先开好、技师做完手上这位再开始，
   *      是每天都在跑的正常流程。开单那一刻并发还没发生。
   *
   * 闸门挪到了 `ticket.startItem`（serviceCapacity.ts）：那才是「同时服务
   * 两位客人」真正成立的时刻，而且那条路上带得了 override。
   */
  const validStaff = await tx<{ membership_id: string }[]>`
    select sp.membership_id
    from staff_profiles sp join memberships m on m.id = sp.membership_id
    where sp.location_id = ${ctx.locationId} and sp.membership_id = any(${staffIds})
      and sp.is_bookable = true and m.status = 'active'`;
  if (validStaff.length !== staffIds.length) {
    throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'staff' } });
  }

  const skillRows = await tx<{ service_id: string; skill_id: string; membership_id: string | null }[]>`
    select ssr.service_id, ssr.skill_id, ss.membership_id
    from service_skill_requirements ssr
    left join staff_skills ss on ss.skill_id = ssr.skill_id and ss.membership_id = any(${staffIds})
    where ssr.location_id = ${ctx.locationId} and ssr.service_id = any(${svcIds})`;
  for (const item of input.items) {
    const service = byId.get(item.serviceId);
    const assignments = assignmentsFor(item);
    if (!service) continue;
    if (assignments.length !== service.staff_count) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
        details: { reason: 'staff_count_mismatch', serviceId: item.serviceId, expected: service.staff_count, received: assignments.length },
      });
    }
    if (new Set(assignments.map((a) => a.membershipId)).size !== assignments.length
      || assignments.filter((a) => a.role === 'primary').length !== 1) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
        details: { reason: 'invalid_staff_assignments', serviceId: item.serviceId },
      });
    }
    const requiredSkillIds = [...new Set(skillRows
      .filter((row) => row.service_id === item.serviceId)
      .map((row) => row.skill_id))];
    for (const assignment of assignments) {
      const missing = requiredSkillIds.some((skillId) => !skillRows.some((row) => (
        row.service_id === item.serviceId
        && row.skill_id === skillId
        && row.membership_id === assignment.membershipId
      )));
      if (missing) {
        throw new AppError(ERROR_CODES.STAFF_LACKS_SKILL, {
          details: { serviceId: item.serviceId, membershipId: assignment.membershipId },
        });
      }
    }
  }

  const resourceIds = [...new Set(input.items
    .map((item) => item.resourceId)
    .concat(appointmentItemSnapshots?.map((s) => s.resourceId ?? undefined) ?? [])
    .filter((id): id is string => Boolean(id)))];
  if (resourceIds.length > 0) {
    const validResources = await tx<{ id: string }[]>`
      select id from resources where location_id = ${ctx.locationId} and id = any(${resourceIds})`;
    if (validResources.length !== resourceIds.length) {
      throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'resource' } });
    }
  }

  const [checkout] = await tx<{ checkout_timing: string }[]>`
    select checkout_timing from location_checkout_settings
    where location_id = ${ctx.locationId}`;
  const checkoutTiming = checkout?.checkout_timing ?? 'after_service_combined';

  const [ticket] = await tx<{ id: string }[]>`
    insert into tickets
      (org_id, location_id, business_date, customer_id, walk_in_name, appointment_id,
       group_id, status, opened_by, checkout_timing_snapshot)
    values (${ctx.orgId}, ${ctx.locationId}, ${date}, ${customerId},
            ${walkInName}, ${input.appointmentId ?? null},
            ${input.groupId ?? null}, 'in_service', ${ctx.membershipId}, ${checkoutTiming})
    returning id`;

  const ticketItemIds: string[] = [];
  for (const [seq, it] of input.items.entries()) {
    const svc = byId.get(it.serviceId);
    if (!svc) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { serviceId: it.serviceId } });
    const snapshot = appointmentItemSnapshots?.[seq];
    const price = snapshot?.priceCents ?? it.priceCentsOverride ?? svc.base_price_cents;
    const mins = snapshot?.durationMin ?? it.minutes ?? svc.duration_min;
    const resourceId = it.resourceId ?? snapshot?.resourceId ?? null;

    const [item] = await tx<{ id: string }[]>`
      insert into ticket_items
        (org_id, location_id, ticket_id, kind, service_id, name_snapshot,
         qty, unit_price_cents, total_cents, duration_min, resource_id, seq)
      values (${ctx.orgId}, ${ctx.locationId}, ${ticket!.id}, 'service', ${it.serviceId},
              ${pickText(svc.name, ctx.locale)}, 1, ${price}, ${price}, ${mins}, ${resourceId}, ${seq})
      returning id`;
    ticketItemIds.push(item!.id);

    for (const assignment of assignmentsFor(it)) {
      await tx`insert into ticket_item_staff (org_id, ticket_item_id, membership_id, role, minutes)
               values (${ctx.orgId}, ${item!.id}, ${assignment.membershipId}, ${assignment.role}, ${assignment.minutes ?? mins})`;
    }
  }

  const subtotal = await recalcTotals(tx, ticket!.id);
  if (input.appointmentId) {
    await tx`update appointments set status = 'in_service'
             where id = ${input.appointmentId}`;
    await tx`update appointment_items set status = 'in_service'
             where appointment_id = ${input.appointmentId}
               and status not in ('cancelled','completed')`;
    for (const [seq, it] of input.items.entries()) {
      if (it.resourceId) {
        await tx`update appointment_items set resource_id = ${it.resourceId}
                 where appointment_id = ${input.appointmentId} and seq = ${seq}
                   and status not in ('cancelled','completed')`;
      }
    }
  }
  audit({ entityType: 'ticket', entityId: ticket!.id,
          after: { itemCount: input.items.length, businessDate: date } });

  // ⭐ 这就是技师手机响铃的那一下（01 §6）。
  // 一张单可能派给两个人（双技师/接力），各发各的 —— 技师端只对自己那条响。
  for (const mid of new Set(input.items.flatMap((i) => assignmentsFor(i).map((a) => a.membershipId)))) {
    emit({ type: 'ticket.assigned', entityId: ticket!.id, membershipId: mid, businessDate: date });
  }
  return { ticketId: ticket!.id, ticketItemIds, subtotalCents: subtotal };
});

// ─────────────────────────────────────────────────────────────────── 加钟/加项

registerHandler(TicketAddItem, async ({ input, ctx, tx, audit, emit }: HandlerArgs<
  typeof TicketAddItem.input._type>) => {
  const [t] = await tx<{ status: string; service_settled_at: string | null }[]>`
    select status, service_settled_at from tickets where id = ${input.ticketId} for update`;
  if (!t) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'ticket' } });
  // 已结账的单不能再加项 —— 要改就得先作废重开，否则金额和已发的小费对不上
  if (t.status === 'closed' || t.status === 'voided' || t.status === 'refunded') {
    throw new AppError(ERROR_CODES.TICKET_ALREADY_CLOSED, { details: { status: t.status } });
  }
  if (t.service_settled_at) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: { reason: 'ticket_items_frozen_after_service_settlement' },
    });
  }

  const [svc] = await tx<{ name: unknown; duration_min: number; base_price_cents: number }[]>`
    select name, duration_min, base_price_cents from services
    where id = ${input.serviceId} and location_id = ${ctx.locationId} and active = true`;
  if (!svc) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { serviceId: input.serviceId } });

  // 与开单同一套校验：在册、在这家店、接客。少了 memberships 那一 join
  // 的话，已离职的技师还能被加钟加到单上（离职当天的加项最常见）。
  const [staff] = await tx<{ membership_id: string }[]>`
    select sp.membership_id from staff_profiles sp
    join memberships m on m.id = sp.membership_id
    where sp.membership_id = ${input.membershipId} and sp.location_id = ${ctx.locationId}
      and sp.is_bookable = true and m.status = 'active'`;
  if (!staff) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'staff' } });

  if (input.resourceId) {
    const [resource] = await tx<{ id: string }[]>`
      select id from resources where id = ${input.resourceId} and location_id = ${ctx.locationId}`;
    if (!resource) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'resource' } });
  }

  const price = input.priceCentsOverride ?? svc.base_price_cents;
  const mins = input.minutes ?? svc.duration_min;

  const [maxSeq] = await tx<{ n: number }[]>`
    select coalesce(max(seq), -1)::int as n from ticket_items where ticket_id = ${input.ticketId}`;

  const [item] = await tx<{ id: string }[]>`
    insert into ticket_items
      (org_id, location_id, ticket_id, kind, service_id, name_snapshot,
       qty, unit_price_cents, total_cents, duration_min, resource_id, seq)
    values (${ctx.orgId}, ${ctx.locationId}, ${input.ticketId}, ${input.kind},
            ${input.serviceId}, ${pickText(svc.name, ctx.locale)}, 1, ${price}, ${price}, ${mins}, ${input.resourceId ?? null},
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
  status: string;
  subtotalCents: number;
  totalCents: number;
  businessDate: string;
  groupId: string | null;
  customerId: string | null;
  checkoutTiming: 'service_then_tip' | 'upfront_combined' | 'after_service_combined';
  serviceSettledAt: string | null;
  tipSettledAt: string | null;
}

async function loadTicketForClose(
  tx: postgres.TransactionSql, ticketId: string, locationId: string,
): Promise<TicketForClose> {
  const [t] = await tx<{
    id: string; status: string; subtotal: number; total_cents: number; business_date: string; group_id: string | null;
    customer_id: string | null; checkout_timing_snapshot: TicketForClose['checkoutTiming'];
    service_settled_at: string | null; tip_settled_at: string | null;
  }[]>`
    select id, status, subtotal_cents as subtotal, total_cents,
           business_date::text as business_date, group_id, customer_id,
           checkout_timing_snapshot, service_settled_at::text as service_settled_at,
           tip_settled_at::text as tip_settled_at
    from tickets where id = ${ticketId} and location_id = ${locationId} for update`;
  if (!t) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'ticket', ticketId } });
  if (t.status === 'closed' || t.status === 'voided' || t.status === 'refunded') {
    throw new AppError(ERROR_CODES.TICKET_ALREADY_CLOSED, { details: { ticketId, status: t.status } });
  }
  return {
    id: t.id, status: t.status, subtotalCents: t.subtotal, totalCents: t.total_cents,
    businessDate: t.business_date, groupId: t.group_id, customerId: t.customer_id,
    checkoutTiming: t.checkout_timing_snapshot,
    serviceSettledAt: t.service_settled_at, tipSettledAt: t.tip_settled_at,
  };
}

/** 结账用到的收款行。amountCents 含小费 —— 与刷卡机小票上的数一致 */
interface PaymentIn {
  method: 'cash' | 'card' | 'external' | 'gift_card' | 'customer_credit';
  amountCents: number;
  tipCents: number;
  tenderedCents?: number | undefined;
  changeCents: number;
  keepChange: boolean;
  /** `method = 'gift_card'` 时二选一（批 8 收尾） */
  giftCardId?: string | undefined;
  giftCardCode?: string | undefined;
}

interface PackageRedemptionIn { customerPackageId: string; units: number }
type CheckoutPackagePolicy = {
  coverageMode: 'bundle' | 'any_included';
  commissionBasis: 'catalog_price' | 'allocated_sale_price' | 'zero';
  allowTipSplitOverride: boolean;
};

async function loadCheckoutPackagePolicy(
  tx: postgres.TransactionSql, locationId: string,
): Promise<CheckoutPackagePolicy> {
  const [row] = await tx<{ settings: Record<string, unknown> }[]>`
    select settings from locations where id = ${locationId}`;
  const checkout = (row?.settings?.['checkout'] ?? {}) as Record<string, unknown>;
  const basis = String(checkout['packageCommissionBasis']);
  return {
    coverageMode: checkout['packageCoverageMode'] === 'any_included' ? 'any_included' : 'bundle',
    commissionBasis: (basis === 'catalog_price' || basis === 'zero') ? basis : 'allocated_sale_price',
    allowTipSplitOverride: checkout['allowTipSplitOverride'] !== false,
  };
}

/** 套餐核销和收款、提成必须在同一事务里成功或回滚。 */
async function applyPackageRedemptions(args: {
  tx: postgres.TransactionSql; ctx: CommandContext; ticket: TicketForClose;
  redemptions: readonly PackageRedemptionIn[]; policy: CheckoutPackagePolicy;
}): Promise<{ coveredCents: number; commissionDiscountByItem: Map<string, number> }> {
  const { tx, ctx, ticket, redemptions, policy } = args;
  const commissionDiscountByItem = new Map<string, number>();
  if (redemptions.length === 0) return { coveredCents: 0, commissionDiscountByItem };
  if (!ticket.customerId) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, { details: { reason: 'package_requires_ticket_customer' } });
  }
  const packageIds = redemptions.map((r) => r.customerPackageId);
  if (new Set(packageIds).size !== packageIds.length) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, { details: { reason: 'duplicate_package_redemption' } });
  }
  const ticketItems = await tx<{ id: string; service_id: string | null; total_cents: number; seq: number }[]>`
    select id, service_id, total_cents, seq from ticket_items
    where ticket_id = ${ticket.id} order by seq, id`;
  const usedItemIds = new Set<string>();
  let coveredCents = 0;

  for (const redemption of redemptions) {
    const units = redemption.units;
    const [pkg] = await tx<{
      id: string; customer_id: string; remaining_sessions: number; total_sessions: number;
      status: string; expires_at: string | null; service_ids: string[]; sold_price_cents: number;
    }[]>`
      select cp.id, cp.customer_id, cp.remaining_sessions, cp.total_sessions, cp.status,
             cp.expires_at::text, coalesce(pt.service_ids, '{}')::text[] as service_ids,
             coalesce((select max(ccl.amount_cents) from customer_credit_ledger ccl
                       where ccl.kind = 'package' and ccl.subject_id = cp.id and ccl.entry = 'issue'),
                      pt.price_cents, 0)::int as sold_price_cents
      from customer_packages cp left join package_templates pt on pt.id = cp.template_id
      where cp.id = ${redemption.customerPackageId} and cp.org_id = ${ctx.orgId}
      for update of cp`;
    if (!pkg) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'customer_package' } });
    if (pkg.customer_id !== ticket.customerId) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, { details: { reason: 'package_ticket_customer_mismatch' } });
    }
    if (pkg.status !== 'active') {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, { details: { reason: 'package_not_active' } });
    }
    if (pkg.expires_at && new Date(pkg.expires_at) < new Date()) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, { details: { reason: 'package_expired' } });
    }
    if (pkg.total_sessions > 0 && pkg.remaining_sessions < units) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
        details: { reason: 'insufficient_sessions', remaining: pkg.remaining_sessions, requested: units },
      });
    }
    const idemKey = `package-redeem-${pkg.id}-${ticket.id}`;
    const [duplicate] = await tx<{ id: string }[]>`
      select id from customer_credit_ledger where location_id = ${ctx.locationId} and idem_key = ${idemKey}`;
    if (duplicate) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, { details: { reason: 'package_already_redeemed_for_ticket' } });
    }

    const eligible = ticketItems.filter((item) => !usedItemIds.has(item.id)
      && (pkg.service_ids.length === 0 || Boolean(item.service_id && pkg.service_ids.includes(item.service_id))));
    const selected: Array<{ id: string; service_id: string | null; total_cents: number; seq: number }> = [];
    if (policy.coverageMode === 'bundle' && pkg.service_ids.length > 0) {
      for (const serviceId of pkg.service_ids) {
        const matches = eligible.filter((item) => item.service_id === serviceId).slice(0, units);
        if (matches.length < units) {
          throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
            details: { reason: 'package_services_not_on_ticket', serviceIds: [serviceId] },
          });
        }
        selected.push(...matches);
      }
    } else {
      selected.push(...eligible.slice(0, units));
      if (selected.length < units) {
        throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
          details: { reason: 'package_services_not_on_ticket', serviceIds: pkg.service_ids },
        });
      }
    }
    selected.forEach((item) => usedItemIds.add(item.id));
    const packageCovered = selected.reduce((sum, item) => sum + item.total_cents, 0);
    coveredCents += packageCovered;
    const consumedBefore = pkg.total_sessions > 0 ? pkg.total_sessions - pkg.remaining_sessions : 0;
    const allocatedSaleBase = pkg.total_sessions > 0
      ? Math.floor(pkg.sold_price_cents * (consumedBefore + units) / pkg.total_sessions)
        - Math.floor(pkg.sold_price_cents * consumedBefore / pkg.total_sessions)
      : 0;
    const commissionBase = policy.commissionBasis === 'catalog_price' ? packageCovered
      : policy.commissionBasis === 'zero' ? 0 : Math.min(packageCovered, allocatedSaleBase);
    const itemBases = commissionBase > 0
      ? largestRemainderSplit(commissionBase, selected.map((item) => item.total_cents))
      : selected.map(() => 0);
    selected.forEach((item, index) => commissionDiscountByItem.set(
      item.id, item.total_cents - (itemBases[index] ?? 0),
    ));

    const nextRemaining = pkg.total_sessions > 0 ? pkg.remaining_sessions - units : pkg.remaining_sessions;
    const nextStatus = pkg.total_sessions > 0 && nextRemaining === 0 ? 'depleted' : 'active';
    await tx`update customer_packages set remaining_sessions = ${nextRemaining}, status = ${nextStatus}, updated_at = now()
             where id = ${pkg.id}`;
    await tx`insert into customer_credit_ledger
      (org_id, location_id, kind, subject_id, customer_id, entry, amount_cents,
       balance_after_cents, ticket_id, reason, actor_membership_id, idem_key, meta)
      values (${ctx.orgId}, ${ctx.locationId}, 'package', ${pkg.id}, ${ticket.customerId}, 'redeem',
              ${-units}, ${nextRemaining}, ${ticket.id}, 'ticket_payment', ${ctx.membershipId}, ${idemKey},
              ${jsonb({ units, ticketItemIds: selected.map((item) => item.id), coveredCents: packageCovered,
                commissionBasis: policy.commissionBasis, commissionBaseCents: commissionBase,
                coverageMode: policy.coverageMode })}::jsonb)`;
  }
  return { coveredCents, commissionDiscountByItem };
}

export interface CloseOutcome {
  ticketId: string;
  closed: boolean;
  totalCents: number;
  tipCents: number;
  taxCents: number;
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
  settlementStage?: 'service' | 'tip' | 'combined';
  packageRedemptions?: readonly PackageRedemptionIn[] | undefined;
}): Promise<CloseOutcome> {
  const { tx, ctx, ticket, payments, discountCents, surchargeCents = 0, tipSplits, loaded } = args;
  const settlementStage = args.settlementStage ?? 'combined';
  const packagePolicy = await loadCheckoutPackagePolicy(tx, ctx.locationId);
  if (!packagePolicy.allowTipSplitOverride && tipSplits && tipSplits.length > 0) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, { details: { reason: 'tip_split_override_disabled' } });
  }
  if (settlementStage === 'tip' && (args.packageRedemptions?.length ?? 0) > 0) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, { details: { reason: 'package_cannot_pay_tip' } });
  }
  const packageApplication = await applyPackageRedemptions({
    tx, ctx, ticket, redemptions: args.packageRedemptions ?? [], policy: packagePolicy,
  });
  const [completion] = await tx<{ complete: boolean }[]>`
    select not exists(
      select 1 from ticket_items where ticket_id = ${ticket.id} and finished_at is null
    ) as complete`;
  const serviceCompleted = completion?.complete ?? false;

  if (settlementStage === 'service') {
    if (ticket.checkoutTiming !== 'service_then_tip' || ticket.serviceSettledAt || ticket.tipSettledAt
      || serviceCompleted) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, { details: { reason: 'service_stage_not_available' } });
    }
    if (payments.some((p) => p.tipCents !== 0)) {
      throw new AppError(ERROR_CODES.PAYMENT_MISMATCH, { details: { reason: 'service_stage_tip_must_be_zero' } });
    }
  } else if (settlementStage === 'tip') {
    if (ticket.checkoutTiming !== 'service_then_tip' || !ticket.serviceSettledAt || ticket.tipSettledAt
      || !serviceCompleted || discountCents !== 0 || (args.taxCents ?? 0) !== 0 || surchargeCents !== 0) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, { details: { reason: 'tip_stage_not_available' } });
    }
    if (payments.some((p) => ['gift_card', 'customer_credit'].includes(p.method))) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, { details: { reason: 'stored_value_cannot_pay_tip' } });
    }
    if (payments.some((p) => p.amountCents === 0)) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, { details: { reason: 'zero_tip_payment_not_allowed' } });
    }
  } else {
    if (ticket.serviceSettledAt || ticket.tipSettledAt
      || (ticket.checkoutTiming === 'service_then_tip')) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, { details: { reason: 'combined_stage_not_available' } });
    }
  }

  const cashTip = payments.filter((p) => p.method === 'cash').reduce((s, p) => s + p.tipCents, 0);
  const cardTip = payments.filter((p) => p.method !== 'cash').reduce((s, p) => s + p.tipCents, 0);
  const totalTip = cashTip + cardTip;
  const paidTotal = payments.reduce((s, p) => s + p.amountCents, 0);
  const checkout = settlementStage === 'tip' ? null : await loadCheckoutSettings(tx, ctx);
  const taxCents = settlementStage === 'tip'
    ? 0
    : locationTaxCents({
      afterDiscountCents: Math.max(
        0,
        ticket.subtotalCents - discountCents - packageApplication.coveredCents,
      ),
      salesTaxRatePercent: checkout!.salesTaxRatePercent,
      taxCalculationMode: checkout!.taxCalculationMode,
    });
  const shouldBe = settlementStage === 'tip'
    ? totalTip
    : ticket.subtotalCents - discountCents - packageApplication.coveredCents
      + taxCents + totalTip + surchargeCents;

  // 收多了收少了当场拦下。
  if (paidTotal !== shouldBe) {
    throw new AppError(ERROR_CODES.PAYMENT_MISMATCH, {
      details: {
        ticketId: ticket.id,
        expected: shouldBe, received: paidTotal,
        hint: '收款额 = 服务金额 − 折扣 − 套餐覆盖 + 税额 + 小费 + 刷卡费',
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

  for (const line of lines) {
    line.item_discount_cents += packageApplication.commissionDiscountByItem.get(line.item_id) ?? 0;
  }

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
      const splitCashAmounts = cashTip > 0
        ? largestRemainderSplit(cashTip, tipSplits.map((s) => s.amountCents))
        : tipSplits.map(() => 0);

      for (const [idx, split] of tipSplits.entries()) {
        if (split.amountCents <= 0) continue;
        const cashPart = splitCashAmounts[idx]!;
        const cardPart = split.amountCents - cashPart;

        const parts: Array<{ src: 'cash' | 'card'; cents: number }> = [];
        if (cashPart > 0) parts.push({ src: 'cash', cents: cashPart });
        if (cardPart > 0) parts.push({ src: 'card', cents: cardPart });

        for (const { src, cents } of parts) {
          await tx`insert into tip_allocations
            (org_id, location_id, ticket_id, membership_id, amount_cents, basis, source, policy_version)
            values (${ctx.orgId}, ${ctx.locationId}, ${ticket.id}, ${split.staffMembershipId},
                    ${cents}, ${jsonb({ method: 'custom_split', percentageBp: split.percentageBp })}::jsonb, ${src}, ${version})`;
          await writeTipEarning({
            tx, ctx, ticketId: ticket.id, businessDate: ticket.businessDate,
            membershipId: split.staffMembershipId, amountCents: cents,
            source: src, basis: { method: 'custom_split' }, policyVersion: version,
          });
          out.push({
            membershipId: split.staffMembershipId,
            name: split.staffName ?? '技师',
            amountCents: cents,
            source: src,
            explain: `自定义分账 $${(cents / 100).toFixed(2)} (${src === 'cash' ? '现金' : '刷卡'})`,
          });
        }
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

  const customerCreditCents = payments
    .filter((p) => p.method === 'customer_credit')
    .reduce((sum, p) => sum + p.amountCents, 0);
  if (customerCreditCents > 0) {
    if (!ticket.customerId) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
        details: { reason: 'customer_credit_requires_ticket_customer' },
      });
    }
    const [customer] = await tx<{ id: string }[]>`
      select id from customers where id = ${ticket.customerId} for update`;
    if (!customer) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'customer' } });
    const [balance] = await tx<{ value: number }[]>`
      select coalesce(sum(amount_cents), 0)::int as value
      from customer_credit_ledger
      where kind = 'store_credit' and customer_id = ${ticket.customerId}`;
    const current = balance?.value ?? 0;
    if (current < customerCreditCents) {
      throw new AppError(ERROR_CODES.STORE_CREDIT_INSUFFICIENT, {
        details: { customerId: ticket.customerId, availableCents: current,
                   requestedCents: customerCreditCents },
      });
    }
    await tx`insert into customer_credit_ledger
      (org_id, location_id, kind, subject_id, customer_id, entry,
       amount_cents, balance_after_cents, ticket_id, reason,
       actor_membership_id, idem_key, meta)
      values (${ctx.orgId}, ${ctx.locationId}, 'store_credit', ${ticket.customerId},
              ${ticket.customerId}, 'redeem', ${-customerCreditCents},
              ${current - customerCreditCents}, ${ticket.id}, 'ticket_payment',
              ${ctx.membershipId}, ${`ticket-credit-use-${ticket.id}`},
              ${jsonb({ paymentMethod: 'customer_credit' })}::jsonb)`;
  }

  // ── 提成落账 ──────────────────────────────────────────────────────────────
  const earnings = settlementStage === 'tip' ? [] : await writeCommissionEarnings({
    tx, ctx, ticketId: ticket.id, businessDate: ticket.businessDate,
    rows: lines as unknown as TicketRevenueRow[],
    ticketDiscountCents: discountCents + giftCardCommissionCut,
    loaded,
  });

  // ── 收款 ──────────────────────────────────────────────────────────────────
  for (const p of payments) {
    await tx`insert into payments
      (org_id, location_id, ticket_id, method, amount_cents, tip_cents,
       tendered_cents, change_cents, keep_change, group_payment_id, payer_ticket_id, taken_by, stage)
      values (${ctx.orgId}, ${ctx.locationId}, ${ticket.id}, ${p.method},
              ${p.amountCents}, ${p.tipCents},
              ${p.tenderedCents ?? null}, ${p.changeCents}, ${p.keepChange},
              ${args.groupPaymentId ?? null}, ${args.payerTicketId ?? null},
              ${ctx.membershipId}, ${settlementStage})`;
  }

  const isUpfrontPendingService = ticket.checkoutTiming === 'upfront_combined' && !serviceCompleted;
  const closeNow = (settlementStage === 'tip' || settlementStage === 'combined') && !isUpfrontPendingService;
  await tx`update tickets set
      status = ${closeNow ? 'closed' : ticket.status},
      closed_at = case when ${closeNow} then now() else closed_at end,
      closed_by = case when ${closeNow} then ${ctx.membershipId} else closed_by end,
      discount_cents = case when ${settlementStage} = 'tip' then discount_cents else ${discountCents} end,
      tax_cents = case when ${settlementStage} = 'tip' then tax_cents else ${taxCents} end,
      surcharge_cents = case when ${settlementStage} = 'tip' then surcharge_cents else ${surchargeCents} end,
      tip_cents = case when ${settlementStage} = 'tip' then tip_cents + ${totalTip} else ${totalTip} end,
      total_cents = case when ${settlementStage} = 'tip' then total_cents + ${paidTotal}
                         else ${paidTotal + packageApplication.coveredCents} end,
      tip_policy_version = ${version},
      service_settled_at = case when ${settlementStage} in ('service', 'combined') then now() else service_settled_at end,
      tip_settled_at = case when ${settlementStage} in ('tip', 'combined') then now() else tip_settled_at end
    where id = ${ticket.id}`;

  // A checked-in appointment remains in walkin_queue until payment succeeds.
  // Advancing it in the same transaction prevents a paid guest from reappearing
  // in the waiting/seated column after the ticket disappears from open tickets.
  if (closeNow) {
    await tx`update ticket_items set
             started_at = coalesce(started_at, now()),
             finished_at = coalesce(finished_at, now())
             where ticket_id = ${ticket.id} and finished_at is null`;
    await tx`update walkin_queue q set status = 'completed'
             from tickets t
             where t.id = ${ticket.id} and q.appointment_id = t.appointment_id
               and q.status <> 'left'`;
    await tx`update appointments a set status = 'done'
             from tickets t
             where t.id = ${ticket.id} and a.id = t.appointment_id`;
  }

  return {
    ticketId: ticket.id,
    totalCents: settlementStage === 'tip'
      ? ticket.totalCents + paidTotal
      : paidTotal + packageApplication.coveredCents,
    closed: closeNow,
    tipCents: totalTip,
    taxCents,
    allocations: out,
    earnings,
  };
}

const handleTicketCloseOrPay = async ({ input, ctx, tx, audit, emit }: HandlerArgs<
  typeof TicketPay.input._type>) => {
  const ticket = await loadTicketForClose(tx, input.ticketId, ctx.locationId);
  await assertDayOpen(tx, ctx.locationId, ticket.businessDate);
  const loaded = await loadPlans(tx, ctx.locationId);

  const r = await closeOneTicket({
    tx, ctx, ticket, payments: input.payments,
    discountCents: input.discountCents,
    surchargeCents: input.surchargeCents,
    tipSplits: input.tipSplits,
    packageRedemptions: input.packageRedemptions,
    loaded,
    settlementStage: input.paymentStage,
  });

  // 审计仅留状态转换；金额仍完全由 command auditRedact 处理。
  audit({
    entityType: 'ticket', entityId: input.ticketId,
    after: {
      settlementStage: input.paymentStage,
      status: r.closed ? 'closed' : ticket.status,
      closed: r.closed,
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
    taxCents: r.taxCents,
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
    customer_id: string | null; service_settled_at: string | null;
  }[]>`
    select id, status, subtotal_cents, discount_cents, tax_cents, surcharge_cents,
           service_charge_cents, tip_cents, total_cents, refund_cents,
           business_date::text as business_date, customer_id,
           service_settled_at::text as service_settled_at
    from tickets
    where id = ${input.ticketId} and location_id = ${ctx.locationId} for update`;

  if (!t) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'ticket' } });
  const prepaidActivity = t.service_settled_at !== null && t.status !== 'closed' && t.status !== 'refunded';
  if (t.status !== 'closed' && t.status !== 'refunded' && !prepaidActivity) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: { reason: 'ticket_not_paid', status: t.status },
    });
  }
  const refundDate = await bizDate(tx, ctx.locationId);
  await assertDayOpen(tx, ctx.locationId, refundDate);

  // A/B have already created financial records before fulfillment.  They may
  // only be cancelled by returning the entire recorded amount; partial refunds
  // would leave an active service with a partially reversed ledger.
  if (prepaidActivity && input.refundAmountCents !== t.total_cents - t.refund_cents) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: { reason: 'prepaid_ticket_requires_full_refund' },
    });
  }

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
    refunded_cash: number; refunded_card: number; refunded_gift: number; refunded_credit: number;
  }[]>`
    select
      coalesce(sum(service_cents), 0)::int as service,
      coalesce(sum(tax_cents), 0)::int as tax,
      coalesce(sum(fee_cents), 0)::int as fee,
      coalesce(sum(tip_cents), 0)::int as tip,
      coalesce(sum(cash_cents), 0)::int as refunded_cash,
      coalesce(sum(card_cents), 0)::int as refunded_card,
      coalesce(sum(gift_card_cents), 0)::int as refunded_gift,
      coalesce(sum(customer_credit_cents), 0)::int as refunded_credit
    from ticket_refunds where ticket_id = ${t.id}`;

  if (prepaidActivity && input.refundTipCents !== t.tip_cents - (already?.tip ?? 0)) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: { reason: 'prepaid_ticket_requires_full_refund' },
    });
  }

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
  let giftCardCents = 0;
  let customerCreditCents = 0;
  if (input.refundMethod === 'cash') {
    cashCents = input.refundAmountCents;
  } else if (input.refundMethod === 'store_credit') {
    customerCreditCents = input.refundAmountCents;
  } else {
    const [paid] = await tx<{ cash: number; card: number; gift: number; credit: number }[]>`
      select
        coalesce(sum(amount_cents) filter (where method = 'cash'), 0)::int as cash,
        coalesce(sum(amount_cents) filter (where method in ('card','external')), 0)::int as card,
        coalesce(sum(amount_cents) filter (where method = 'gift_card'), 0)::int as gift,
        coalesce(sum(amount_cents) filter (where method = 'customer_credit'), 0)::int as credit
      from payments where ticket_id = ${t.id}`;
    const remainingChannels = [
      Math.max(0, (paid?.cash ?? 0) - (already?.refunded_cash ?? 0)),
      Math.max(0, (paid?.card ?? 0) - (already?.refunded_card ?? 0)),
      Math.max(0, (paid?.gift ?? 0) - (already?.refunded_gift ?? 0)),
      Math.max(0, (paid?.credit ?? 0) - (already?.refunded_credit ?? 0)),
    ];
    if (remainingChannels.reduce((sum, value) => sum + value, 0) < input.refundAmountCents) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
        details: { reason: 'original_payment_refund_exceeds_channel_balance' },
      });
    }
    [cashCents, cardCents, giftCardCents, customerCreditCents] = largestRemainderSplit(
      input.refundAmountCents, remainingChannels, { zeroWeights: 'throw' },
    ) as [number, number, number, number];
  }

  const [refund] = await tx<{ id: string }[]>`
    insert into ticket_refunds
      (org_id, location_id, ticket_id, business_date, amount_cents,
       service_cents, tax_cents, fee_cents, tip_cents,
       cash_cents, card_cents, gift_card_cents, customer_credit_cents,
       method, reason, notes, refunded_by)
    values
      (${ctx.orgId}, ${ctx.locationId}, ${t.id}, ${refundDate}, ${input.refundAmountCents},
       ${serviceCents}, ${taxCents}, ${feeCents}, ${input.refundTipCents},
       ${cashCents}, ${cardCents}, ${giftCardCents}, ${customerCreditCents},
       ${input.refundMethod}, ${input.reason}, ${input.notes ?? null}, ${ctx.membershipId})
    returning id`;

  if (customerCreditCents > 0 && input.refundMethod === 'store_credit') {
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
              'refund', ${customerCreditCents}, ${(credit?.balance ?? 0) + customerCreditCents}, ${t.id},
              ${input.reason}, ${ctx.membershipId}, ${`ticket-refund-${refund!.id}`},
              ${jsonb({ refundId: refund!.id })}::jsonb)`;
  }

  if (giftCardCents > 0 && input.refundMethod === 'original_payment') {
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
    if (remaining.reduce((sum, value) => sum + value, 0) < giftCardCents) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
        details: { reason: 'gift_card_refund_source_missing' },
      });
    }
    const giftRefunds = largestRemainderSplit(giftCardCents, remaining);
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

  if (customerCreditCents > 0 && input.refundMethod === 'original_payment') {
    if (!t.customer_id) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
        details: { reason: 'customer_credit_refund_customer_missing' },
      });
    }
    await tx`select id from customers where id = ${t.customer_id} for update`;
    const [used] = await tx<{ redeemed: number; returned: number }[]>`
      select
        coalesce(-sum(amount_cents) filter (where entry = 'redeem'), 0)::int as redeemed,
        coalesce(sum(amount_cents) filter (where entry = 'refund'
          and meta->>'originalCustomerCredit' = 'true'), 0)::int as returned
      from customer_credit_ledger
      where kind = 'store_credit' and customer_id = ${t.customer_id} and ticket_id = ${t.id}`;
    if ((used?.redeemed ?? 0) - (used?.returned ?? 0) < customerCreditCents) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
        details: { reason: 'customer_credit_refund_source_missing' },
      });
    }
    const [balance] = await tx<{ value: number }[]>`
      select coalesce(sum(amount_cents), 0)::int as value from customer_credit_ledger
      where kind = 'store_credit' and customer_id = ${t.customer_id}`;
    await tx`insert into customer_credit_ledger
      (org_id, location_id, kind, subject_id, customer_id, entry,
       amount_cents, balance_after_cents, ticket_id, reason,
       actor_membership_id, idem_key, meta)
      values (${ctx.orgId}, ${ctx.locationId}, 'store_credit', ${t.customer_id}, ${t.customer_id},
              'refund', ${customerCreditCents}, ${(balance?.value ?? 0) + customerCreditCents},
              ${t.id}, ${input.reason}, ${ctx.membershipId},
              ${`ticket-refund-${refund!.id}-customer-credit`},
              ${jsonb({ refundId: refund!.id, originalCustomerCredit: true })}::jsonb)`;
  }

  if (cashCents > 0) {
    await tx`insert into cash_movements
      (org_id, location_id, business_date, kind, amount_cents, note, actor_id)
      values (${ctx.orgId}, ${ctx.locationId}, ${refundDate}, 'refund', ${-cashCents},
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
    await tx`update appointments a set status = 'cancelled'
             from tickets ticket where ticket.id = ${t.id} and a.id = ticket.appointment_id`;
    await tx`update appointment_items ai set status = 'cancelled'
             from tickets ticket where ticket.id = ${t.id} and ai.appointment_id = ticket.appointment_id
               and ai.status <> 'completed'`;
    await tx`update walkin_queue q
             set status = 'left', left_at = now(),
                 left_reason = coalesce(q.left_reason, ${queueLeftReasonOnFullRefund()})
             from tickets ticket where ticket.id = ${t.id}
               and q.appointment_id = ticket.appointment_id and q.status <> 'left'`;
  }

  // ⚠️ 财务冲销，严禁篡改已打烊封账日的历史日结记录（宪法第 9 条）。
  // 无论是全额退款还是部分退款，提成与小费的冲销一律作为负向记录写入当前营业日（refundDate），
  // 保证历史日结报表分文不变，当日工资扣减真实有据。
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
        values (${ctx.orgId}, ${ctx.locationId}, ${row.membership_id}, ${refundDate},
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
        values (${ctx.orgId}, ${ctx.locationId}, ${row.membership_id}, ${refundDate},
                ${row.source === 'cash' ? 'tip_cash' : 'tip_card'}, ${-delta}, 0, ${t.id},
                ${basis}::jsonb, ${row.policy_version})`;
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
    where id = any(${input.ticketIds}) and location_id = ${ctx.locationId} and status not in ('closed','voided')
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
    where id = ${input.ticketId} and location_id = ${ctx.locationId} and status not in ('closed','voided')
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
  const sortedTicketIds = [...input.ticketIds].sort();
  const ticketsById = new Map<string, TicketForClose>();
  for (const id of sortedTicketIds) {
    const t = await loadTicketForClose(tx, id, ctx.locationId);
    if (t.groupId !== input.groupId) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
        details: { ticketId: id, reason: '这张单不属于这一组' },
      });
    }
    ticketsById.set(id, t);
  }
  const tickets = input.ticketIds.map((id) => ticketsById.get(id)!);
  await assertDayOpen(tx, ctx.locationId, tickets[0]!.businessDate);

  const subtotals = tickets.map((t) => t.subtotalCents);
  const subtotalSum = subtotals.reduce((a, b) => a + b, 0);

  const tipSum = input.payments.reduce((s, p) => s + p.tipCents, 0);
  const paidSum = input.payments.reduce((s, p) => s + p.amountCents, 0);
  const discounts = largestRemainderSplit(input.discountCents, subtotals);
  const checkout = await loadCheckoutSettings(tx, ctx);
  const taxes = tickets.map((t, i) => locationTaxCents({
    afterDiscountCents: Math.max(0, t.subtotalCents - (discounts[i] ?? 0)),
    salesTaxRatePercent: checkout.salesTaxRatePercent,
    taxCalculationMode: checkout.taxCalculationMode,
  }));
  const taxSum = taxes.reduce((sum, value) => sum + value, 0);
  const expected = subtotalSum - input.discountCents + taxSum + input.surchargeCents + tipSum;
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
    from tickets where id = ${input.ticketId} and location_id = ${ctx.locationId} for update`;
  if (!t) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'ticket' } });
  if (t.status === 'closed') {
    throw new AppError(ERROR_CODES.TICKET_ALREADY_CLOSED, {
      details: { ticketId: input.ticketId, hint: '已结账工单不可作废，请走退款流程 (ticket.refund)' },
    });
  }
  if (t.status === 'voided' || t.status === 'refunded') {
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

  const occupiedResources = await tx<{ resource_id: string }[]>`
    select distinct ro.resource_id
    from resource_occupancies ro join ticket_items ti on ti.id = ro.ticket_item_id
    where ti.ticket_id = ${input.ticketId} and ro.status = 'in_use'
    order by ro.resource_id`;
  if (occupiedResources.length > 0) {
    const resourceIds = occupiedResources.map((row) => row.resource_id);
    await tx`select id from resources where id = any(${resourceIds}) order by id for update`;
    await tx`update resource_occupancies ro set
        status = case when ti.started_at is null then 'released' else 'cleaning_required' end,
        released_at = case when ti.started_at is null then now() else null end,
        updated_by = ${ctx.membershipId}
      from ticket_items ti
      where ti.id = ro.ticket_item_id and ti.ticket_id = ${input.ticketId}
        and ro.status = 'in_use'`;
    await tx`update resources r set status = case
        when exists (select 1 from resource_occupancies ro where ro.resource_id = r.id and ro.status = 'in_use')
          then 'in_use'
        when exists (select 1 from resource_occupancies ro where ro.resource_id = r.id and ro.status = 'cleaning_required')
          then 'cleaning_required'
        else 'available' end
      where r.id = any(${resourceIds})`;
  }

  await tx`update tickets set
      status = 'voided', voided_at = now(), voided_by = ${ctx.membershipId},
      void_reason = ${input.reason}, void_note = ${input.note ?? null}
    where id = ${input.ticketId}`;

  if (t.appointment_id) {
    if (voidCancelsAppointment(input.reason)) {
      // 客人改主意 / 离店：工单作废同时撤预约，否则房间还挂着那场。
      await tx`update appointments set
          status = 'cancelled', cancelled_at = now(),
          cancel_reason = ${input.reason},
          cancel_note = ${input.note ?? null}
        where id = ${t.appointment_id}`;
      await tx`update appointment_items set status = 'cancelled'
               where appointment_id = ${t.appointment_id} and status <> 'cancelled'`;
      await tx`update walkin_queue set
          status = 'left', left_at = now(),
          left_reason = coalesce(left_reason, ${queueLeftReasonOnVoid(input.reason)})
        where appointment_id = ${t.appointment_id} and status <> 'left'`;
    } else {
      // 录入错误：回到已签到，允许且只允许重开一张替代单。
      await tx`update appointments set status = 'checked_in'
               where id = ${t.appointment_id}`;
      await tx`update appointment_items set status = 'booked'
               where appointment_id = ${t.appointment_id} and status <> 'cancelled'`;
      await tx`update walkin_queue set status = 'waiting'
               where appointment_id = ${t.appointment_id} and status <> 'left'`;
    }
  }

  audit({
    entityType: 'ticket', entityId: input.ticketId,
    before: { status: t.status },
    after: { status: 'voided', reason: input.reason, note: input.note ?? null },
  });
  emit({ type: 'ticket.changed', entityId: input.ticketId, businessDate: t.business_date });
  return { ticketId: input.ticketId, status: 'voided' as const };
});

/*
 * ⚠️ `ticket.sendReceipt` 已于 2026-09-01 整体移除（店主定）。
 *
 * 消费小票不再通过短信或邮件发送，只保留打印。移除的是**整条命令**而不是
 * 加一个开关：留着一条永远返回错误的命令，前台仍会看到那个按钮、点下去
 * 拿到一句报错，而她无从判断这是故障还是设计。
 *
 * 一并移除的还有 `location_checkout_settings.auto_send_sms_receipt` 的
 * 界面入口与 `checkout.receipt*` 那组文案。数据库那一列保留 —— 删列要停机，
 * 而它现在没有任何读取方。
 */
