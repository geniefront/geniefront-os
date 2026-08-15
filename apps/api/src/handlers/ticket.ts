/**
 * 工单命令实现。
 *
 * 小费分配调 packages/payroll 的纯函数 —— 唯一实现（宪法第 2 条）。
 * 结账时把 basis 快照落库，之后改规则也不影响这一单（策略版本化）。
 */

import type postgres from 'postgres';
import {
  TicketOpen, TicketAddItem, TicketClose, TicketVoid,
  AppError, ERROR_CODES, type CommandContext, pickText
} from '@gf/contracts';
import {
  allocateTip, explainAllocation, DEFAULT_TIP_POLICY,
  TipPolicyError, type ServiceLine, type TipPolicy,
} from '@gf/payroll';
import { businessDateOf, } from '@gf/scheduling';
import { jsonb } from '@gf/db';
import { registerHandler, type HandlerArgs } from '../bus';

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

registerHandler(TicketOpen, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof TicketOpen.input._type>) => {
  const date = await bizDate(tx, ctx.locationId);

  const svcIds = [...new Set(input.items.map((i) => i.serviceId))];
  const svcs = await tx<{
    id: string; name: unknown; duration_min: number; base_price_cents: number;
  }[]>`select id, name, duration_min, base_price_cents from services
       where id = any(${svcIds}) and active = true`;
  const byId = new Map(svcs.map((s) => [s.id, s]));

  const [ticket] = await tx<{ id: string }[]>`
    insert into tickets
      (org_id, location_id, business_date, customer_id, walk_in_name, appointment_id,
       status, opened_by)
    values (${ctx.orgId}, ${ctx.locationId}, ${date}, ${input.customerId},
            ${input.walkInName ?? null}, ${input.appointmentId ?? null},
            'in_service', ${ctx.membershipId})
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
  return { ticketId: ticket!.id, subtotalCents: subtotal };
});

// ─────────────────────────────────────────────────────────────────── 加钟/加项

registerHandler(TicketAddItem, async ({ input, ctx, tx, audit }: HandlerArgs<
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
  return { ticketItemId: item!.id, subtotalCents: subtotal };
});

// ─────────────────────────────────────────────────────────────────── 结账

registerHandler(TicketClose, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof TicketClose.input._type>) => {
  const [t] = await tx<{ status: string; subtotal: number }[]>`
    select status, subtotal_cents as subtotal from tickets where id = ${input.ticketId}`;
  if (!t) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'ticket' } });
  if (t.status === 'closed' || t.status === 'voided') {
    throw new AppError(ERROR_CODES.TICKET_ALREADY_CLOSED, { details: { status: t.status } });
  }

  const lines = await tx<{
    item_id: string; name: string; total_cents: number;
    membership_id: string; role: string; minutes: number;
    staff_name: unknown; level_key: string | null;
  }[]>`
    select ti.id as item_id, ti.name_snapshot as name, ti.total_cents,
           tis.membership_id, tis.role, tis.minutes,
           sp.display_name as staff_name, sl.key as level_key
    from ticket_items ti
    join ticket_item_staff tis on tis.ticket_item_id = ti.id
    left join staff_profiles sp on sp.membership_id = tis.membership_id
    left join staff_levels sl on sl.id = sp.level_id
    where ti.ticket_id = ${input.ticketId}`;

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

  // 现金小费与刷卡小费分开算：现金当天发，刷卡进工资（00 §3.1）
  const cashTip = input.payments.filter((p) => p.method === 'cash')
    .reduce((s, p) => s + p.tipCents, 0);
  const cardTip = input.payments.filter((p) => p.method !== 'cash')
    .reduce((s, p) => s + p.tipCents, 0);
  const totalTip = cashTip + cardTip;
  const paidTotal = input.payments.reduce((s, p) => s + p.amountCents, 0);

  let out: Array<{ membershipId: string; name: string; amountCents: number;
                   source: 'cash' | 'card'; explain: string }> = [];
  try {
    for (const [src, amount] of [['cash', cashTip], ['card', cardTip]] as const) {
      if (amount <= 0) continue;
      const r = allocateTip(amount, serviceLines, policy);
      for (const a of r.allocations) {
        await tx`insert into tip_allocations
          (org_id, location_id, ticket_id, membership_id, amount_cents, basis, source, policy_version)
          values (${ctx.orgId}, ${ctx.locationId}, ${input.ticketId}, ${a.membershipId},
                  ${a.amountCents}, ${jsonb(a.basis)}::jsonb, ${src}, ${version})`;
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

  for (const p of input.payments) {
    await tx`insert into payments
      (org_id, location_id, ticket_id, method, amount_cents, tip_cents, taken_by)
      values (${ctx.orgId}, ${ctx.locationId}, ${input.ticketId}, ${p.method},
              ${p.amountCents}, ${p.tipCents}, ${ctx.membershipId})`;
  }

  await tx`update tickets set
      status = 'closed', closed_at = now(), closed_by = ${ctx.membershipId},
      discount_cents = ${input.discountCents},
      tip_cents = ${totalTip},
      total_cents = ${paidTotal},
      tip_policy_version = ${version}
    where id = ${input.ticketId}`;

  // 审计留动作不留金额：只记「结了、几种支付方式、分给几个人」
  audit({
    entityType: 'ticket', entityId: input.ticketId,
    after: {
      status: 'closed',
      methods: input.payments.map((p) => p.method),
      allocationCount: out.length,
      tipPolicyVersion: version,
    },
  });

  return { ticketId: input.ticketId, totalCents: paidTotal, tipCents: totalTip, allocations: out };
});

// ─────────────────────────────────────────────────────────────────── 作废

registerHandler(TicketVoid, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof TicketVoid.input._type>) => {
  const [t] = await tx<{ status: string }[]>`
    select status from tickets where id = ${input.ticketId}`;
  if (!t) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'ticket' } });
  if (t.status === 'voided') {
    throw new AppError(ERROR_CODES.ALREADY_CANCELLED, { details: { status: t.status } });
  }

  // 作废要把已经分出去的小费一并撤掉，否则技师的当日收入会虚高
  await tx`delete from tip_allocations where ticket_id = ${input.ticketId}`;

  await tx`update tickets set
      status = 'voided', voided_at = now(), voided_by = ${ctx.membershipId},
      void_reason = ${input.reason}, void_note = ${input.note ?? null}
    where id = ${input.ticketId}`;

  audit({
    entityType: 'ticket', entityId: input.ticketId,
    before: { status: t.status },
    after: { status: 'voided', reason: input.reason, note: input.note ?? null },
  });
  return { ticketId: input.ticketId, status: 'voided' as const };
});
