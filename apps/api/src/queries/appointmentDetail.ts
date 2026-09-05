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
  notes: string | null;
  createdAt: string;
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
        phone: wq.customer_phone,
        hasHealthForm,
        healthFormSubmissionId,
        allergiesSummary: null,
      },
      items,
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
  }[]>`
    select ai.id as item_id, ai.service_id, s.name as service_name,
           ai.price_cents_snapshot as price_cents, ai.duration_min, ai.starts_at::text as starts_at,
           ai.membership_id, sp.display_name as staff_display_name,
           u.full_name as user_full_name,
           ai.resource_id, r.name as resource_name, ai.status
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
    };
  });

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
    notes: apt.notes,
    createdAt: apt.created_at,
  };
}
