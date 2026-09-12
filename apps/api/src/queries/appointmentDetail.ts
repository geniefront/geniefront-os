/**
 * 预约单据详情与健康表穿透查询（AppointmentDrawer.tsx，P0 预约详情）
 */

import type postgres from 'postgres';
import { pickText, AppError, ERROR_CODES, type CommandContext } from '@gf/contracts';
import { maskPhone } from './staff';

export interface AppointmentItemDetailDto {
  itemId: string;
  serviceId: string;
  serviceName: string;
  staffId: string | null;
  staffName: string | null;
  resourceId: string | null;
  resourceName: string | null;
  startsAt: string;
  durationMin: number;
  priceCents: number;
  status: string;
  /** 组合套餐来源（U10）。普通预约项为 null。 */
  bundleInstanceId: string | null;
}

/** 本条预约里的组合套餐实例（U10 / 计划 §7「预约详情：只读展示已选套餐」）。 */
export interface AppointmentBundleDto {
  instanceId: string;
  name: string;
  originalTotalCents: number;
  bundlePriceCents: number;
  bundleDiscountCents: number;
  extraDiscountCents: number;
  unitCount: number;
  status: string;
}

/** 详情与看板共用的状态映射所需的活动工单事实（`queueNextAction` / `paymentStageFor` 的入参子集）。 */
export interface AppointmentTicketFactsDto {
  ticketId: string;
  number: number | null;
  status: string;
  checkoutTiming: 'service_then_tip' | 'upfront_combined' | 'after_service_combined';
  serviceSettledAt: string | null;
  tipSettledAt: string | null;
  serviceCompleted: boolean;
  items: Array<{
    ticketItemId: string;
    name: string;
    startedAt: string | null;
    finishedAt: string | null;
  }>;
}

export interface AppointmentDetailDto {
  appointmentId: string;
  status: string;
  customer: {
    id: string | null;
    name: string;
    phone: string | null;
    hasHealthForm: boolean;
    healthFormSubmissionId: string | null;
    allergiesSummary: string | null;
  };
  items: AppointmentItemDetailDto[];
  /** 组合套餐实例。无则为空数组。 */
  bundles: AppointmentBundleDto[];
  /** 有活动工单（open / in_service / ready_to_pay）时非空。 */
  ticket: AppointmentTicketFactsDto | null;
  notes: string | null;
  createdAt: string;
}

async function loadTicketFacts(
  tx: postgres.TransactionSql,
  ctx: CommandContext,
  appointmentId: string,
): Promise<AppointmentTicketFactsDto | null> {
  const [tk] = await tx<{
    id: string; status: string;
    checkout_timing_snapshot: string;
    service_settled_at: string | null; tip_settled_at: string | null;
  }[]>`
    select t.id, t.status, t.checkout_timing_snapshot,
           t.service_settled_at::text as service_settled_at,
           t.tip_settled_at::text as tip_settled_at
    from tickets t
    where t.appointment_id = ${appointmentId} and t.location_id = ${ctx.locationId}
    order by t.opened_at desc
    limit 1`;
  if (!tk) return null;

  const itemRows = await tx<{
    id: string; name_snapshot: string; started_at: string | null; finished_at: string | null;
  }[]>`
    select ti.id, ti.name_snapshot, ti.started_at::text as started_at, ti.finished_at::text as finished_at
    from ticket_items ti
    where ti.ticket_id = ${tk.id}
    order by ti.seq`;

  return {
    ticketId: tk.id,
    number: null,
    status: tk.status,
    checkoutTiming: (tk.checkout_timing_snapshot as AppointmentTicketFactsDto['checkoutTiming']) || 'after_service_combined',
    serviceSettledAt: tk.service_settled_at,
    tipSettledAt: tk.tip_settled_at,
    serviceCompleted: itemRows.length > 0 && itemRows.every((r) => r.finished_at !== null),
    items: itemRows.map((r) => ({
      ticketItemId: r.id,
      name: r.name_snapshot,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
    })),
  };
}

export async function loadAppointmentDetail(
  tx: postgres.TransactionSql,
  ctx: CommandContext,
  appointmentId: string,
): Promise<AppointmentDetailDto> {
  let [apt] = await tx<{
    id: string; customer_id: string | null; status: string;
    notes: string | null; walk_in_name: string | null;
    created_at: string; customer_name: string | null;
    customer_phone: string | null;
  }[]>`
    select a.id, a.customer_id, a.status, a.notes, a.walk_in_name,
           a.created_at::text as created_at,
           c.display_name as customer_name,
           c.phone_e164 as customer_phone
    from appointments a
    left join customers c on c.id = a.customer_id
    where a.id = ${appointmentId} and a.location_id = ${ctx.locationId}`;

  if (!apt) {
    // 兼容现场排队单据 (walkin_queue)
    const [wq] = await tx<{
      id: string; customer_id: string | null; status: string;
      walk_in_name: string | null; joined_at: string;
      requested_service_id: string | null; appointment_id: string | null;
      customer_name: string | null; customer_phone: string | null;
    }[]>`
      select w.id, w.customer_id, w.status, w.walk_in_name,
             w.joined_at::text as joined_at,
             w.requested_service_id, w.appointment_id,
             c.display_name as customer_name,
             c.phone_e164 as customer_phone
      from walkin_queue w
      left join customers c on c.id = w.customer_id
      where w.id = ${appointmentId} and w.location_id = ${ctx.locationId}`;

    if (!wq) {
      throw new AppError(ERROR_CODES.NOT_FOUND, {
        details: { entity: 'appointment', id: appointmentId },
      });
    }

    if (wq.appointment_id) {
      return loadAppointmentDetail(tx, ctx, wq.appointment_id);
    }

    let items: AppointmentItemDetailDto[] = [];
    if (wq.requested_service_id) {
      const [svc] = await tx<{ id: string; name: unknown; duration_min: number; base_price_cents: number }[]>`
        select id, name, duration_min, base_price_cents from services
        where id = ${wq.requested_service_id} and location_id = ${ctx.locationId}`;
      if (svc) {
        items = [{
          itemId: `wq-item-${wq.id}`,
          serviceId: svc.id,
          serviceName: pickText(svc.name, ctx.locale, '现场服务'),
          staffId: null,
          staffName: null,
          resourceId: null,
          resourceName: null,
          startsAt: wq.joined_at,
          durationMin: svc.duration_min,
          priceCents: svc.base_price_cents,
          status: wq.status === 'in_service' ? 'in_service' : 'booked',
          bundleInstanceId: null,
        }];
      }
    }

    const [sub] = await tx<{ id: string }[]>`
      select id from form_submissions
      where queue_id = ${wq.id} and location_id = ${ctx.locationId}
        and anonymized_at is null
      order by created_at desc limit 1`;
    const hasHealthForm = Boolean(sub);
    const healthFormSubmissionId = sub?.id ?? null;

    return {
      appointmentId: wq.id,
      status: wq.status === 'waiting' ? 'checked_in' : wq.status === 'in_service' ? 'in_service' : 'booked',
      customer: {
        id: wq.customer_id,
        name: wq.customer_name ?? wq.walk_in_name ?? '客人',
        phone: ctx.permissions.has('customer.view_contact') ? wq.customer_phone : maskPhone(wq.customer_phone),
        hasHealthForm,
        healthFormSubmissionId,
        allergiesSummary: null,
      },
      items,
      bundles: [],
      ticket: null,
      notes: null,
      createdAt: wq.joined_at,
    };
  }

  // 1. 查询客户的健康表与偏好禁忌
  let hasHealthForm = false;
  let healthFormSubmissionId: string | null = null;
  let allergiesSummary: string | null = null;

  if (apt.customer_id) {
    const [sub] = await tx<{ id: string }[]>`
      select id from form_submissions
      where customer_id = ${apt.customer_id} and location_id = ${ctx.locationId}
      order by created_at desc limit 1`;
    if (sub) {
      hasHealthForm = true;
      healthFormSubmissionId = sub.id;
    }

    const [pref] = await tx<{ allergies: unknown; free_notes: string | null }[]>`
      select allergies, free_notes from customer_preferences
      where customer_id = ${apt.customer_id}`;
    if (pref?.allergies && typeof pref.allergies === 'object') {
      const all = pref.allergies as Record<string, unknown>;
      const custom = typeof all['customNotes'] === 'string' ? all['customNotes'] : '';
      const list = Array.isArray(all['skinAllergies']) ? all['skinAllergies'].join(', ') : '';
      allergiesSummary = [list, custom].filter(Boolean).join('；') || null;
    } else if (pref?.free_notes) {
      allergiesSummary = pref.free_notes;
    }
  }

  // 2. 查询预约项列表
  const itemRows = await tx<{
    item_id: string; service_id: string; service_name: unknown;
    price_cents: number; duration_min: number; starts_at: string;
    membership_id: string | null; staff_display_name: unknown;
    user_full_name: string | null; resource_id: string | null;
    resource_name: string | null; status: string;
    bundle_instance_id: string | null;
  }[]>`
    select ai.id as item_id, ai.service_id, s.name as service_name,
           ai.price_cents_snapshot as price_cents, ai.duration_min, ai.starts_at::text as starts_at,
           ai.membership_id, sp.display_name as staff_display_name,
           u.full_name as user_full_name,
           ai.resource_id, r.name as resource_name, ai.status,
           ai.bundle_instance_id
    from appointment_items ai
    join services s on s.id = ai.service_id
    left join memberships m on m.id = ai.membership_id
    left join staff_profiles sp on sp.membership_id = ai.membership_id
    left join users u on u.id = m.user_id
    left join resources r on r.id = ai.resource_id
    where ai.appointment_id = ${appointmentId}
    order by ai.starts_at asc`;

  const items: AppointmentItemDetailDto[] = itemRows.map((r) => {
    const staffName = r.staff_display_name
      ? pickText(r.staff_display_name, ctx.locale, r.user_full_name ?? '技师')
      : (r.user_full_name ?? null);

    return {
      itemId: r.item_id,
      serviceId: r.service_id,
      serviceName: pickText(r.service_name, ctx.locale, '项目服务'),
      staffId: r.membership_id,
      staffName,
      resourceId: r.resource_id,
      resourceName: r.resource_name,
      startsAt: r.starts_at,
      durationMin: r.duration_min,
      priceCents: r.price_cents,
      status: r.status,
      bundleInstanceId: r.bundle_instance_id,
    };
  });

  // 组合套餐实例（只读展示）。金额取下单时锁定的快照，不重算。
  const bundleRows = await tx<{
    id: string; name_snapshot: unknown;
    original_total_cents: number; bundle_price_cents: number;
    discount_cents: number; extra_discount_cents: number; status: string;
  }[]>`
    select id, name_snapshot, original_total_cents, bundle_price_cents,
           discount_cents, extra_discount_cents, status
    from order_bundle_instances
    where appointment_id = ${appointmentId} and location_id = ${ctx.locationId}
    order by created_at asc`;
  const bundles = bundleRows.map((b) => ({
    instanceId: b.id,
    name: pickText(b.name_snapshot, ctx.locale, '组合套餐'),
    originalTotalCents: b.original_total_cents,
    bundlePriceCents: b.bundle_price_cents,
    bundleDiscountCents: b.discount_cents,
    extraDiscountCents: b.extra_discount_cents,
    unitCount: itemRows.filter((r) => r.bundle_instance_id === b.id).length,
    status: b.status,
  }));

  const ticket = await loadTicketFacts(tx, ctx, apt.id);

  return {
    appointmentId: apt.id,
    status: apt.status,
    customer: {
      id: apt.customer_id,
      name: apt.customer_name ?? apt.walk_in_name ?? '客人',
      phone: ctx.permissions.has('customer.view_contact') ? apt.customer_phone : maskPhone(apt.customer_phone),
      hasHealthForm,
      healthFormSubmissionId,
      allergiesSummary,
    },
    items,
    bundles,
    ticket,
    notes: apt.notes,
    createdAt: apt.created_at,
  };
}
