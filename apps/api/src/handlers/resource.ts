/**
 * 房间与工位资源命令处理器（02-DATA-MODEL §7，P0 房态看板）
 */

import {
  resourceSetStatus, resourceSave, resourceDelete, resourceBeginCleaning,
  resourceCompleteCleaning, ticketMoveItemResource, AppError, ERROR_CODES,
} from '@gf/contracts';
import { jsonb } from '@gf/db';
import { assertResourceStaffLimit } from '../resourceStaffLimit';
import { registerHandler } from '../bus';

// ─────────────────────────────────────────────────────────── resource.setStatus

registerHandler(resourceSetStatus, async ({ input, ctx, tx, audit }) => {
  const [res] = await tx<{ id: string; status: string; name: string }[]>`
    select id, status, name from resources
    where id = ${input.resourceId} and location_id = ${ctx.locationId} for update`;
  if (!res) {
    throw new AppError(ERROR_CODES.NOT_FOUND, {
      details: { entity: 'resource', id: input.resourceId },
    });
  }

  const [busy] = await tx<{ count: number }[]>`
    select count(*)::int as count from resource_occupancies
    where resource_id = ${input.resourceId} and status <> 'released'`;
  if ((busy?.count ?? 0) > 0 && input.status !== res.status) {
    throw new AppError(ERROR_CODES.RESOURCE_CONFLICT, { details: { reason: 'resource_has_active_occupancies' } });
  }
  const before = { status: res.status, name: res.name };

  const allowed = input.status === 'maintenance'
    || (input.status === 'available' && ['maintenance', 'in_use'].includes(res.status) && (busy?.count ?? 0) === 0);
  if (!allowed && input.status !== res.status) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: { reason: 'resource_state_is_workflow_managed', from: res.status, to: input.status },
    });
  }

  await tx`
    update resources
    set status = ${input.status}
    where id = ${input.resourceId} and location_id = ${ctx.locationId}`;

  audit({
    entityType: 'resource',
    entityId: input.resourceId,
    before,
    after: {
      status: input.status,
      note: input.note ?? null,
      guestName: input.guestName ?? null,
      serviceName: input.serviceName ?? null,
    },
  });

  return {
    resourceId: input.resourceId,
    status: input.status,
  };
});

registerHandler(resourceBeginCleaning, async ({ input, ctx, tx, audit }) => {
  const [resource] = await tx<{ id: string; status: string }[]>`
    select id, status from resources where id = ${input.resourceId}
      and location_id = ${ctx.locationId} for update`;
  if (!resource) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'resource' } });
  const rows = await tx<{ id: string }[]>`
    update resource_occupancies set status = 'cleaning', cleaning_started_at = now(),
      updated_by = ${ctx.membershipId}
    where resource_id = ${resource.id} and status = 'cleaning_required'
    returning id`;
  if (rows.length === 0 && !['available', 'cleaning'].includes(resource.status)) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: { reason: 'resource_not_waiting_for_cleaning', status: resource.status },
    });
  }
  await tx`update resources set status = case when exists (select 1 from resource_occupancies where resource_id = ${resource.id} and status = 'in_use') then 'in_use' else 'cleaning' end where id = ${resource.id}`;
  audit({ entityType: 'resource', entityId: resource.id,
          before: { status: resource.status },
          after: { status: 'cleaning', occupancyCount: rows.length, note: input.note ?? null } });
  return { resourceId: resource.id, status: 'cleaning' as const };
});

registerHandler(resourceCompleteCleaning, async ({ input, ctx, tx, audit }) => {
  const [resource] = await tx<{ id: string; status: string }[]>`
    select id, status from resources where id = ${input.resourceId}
      and location_id = ${ctx.locationId} for update`;
  if (!resource) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'resource' } });
  if (resource.status === 'available') {
    audit({ entityType: 'resource', entityId: resource.id,
            after: { status: 'available', alreadyCompleted: true } });
    return { resourceId: resource.id, status: 'available' as const };
  }
  const [cleaning] = await tx<{ count: number }[]>`select count(*)::int as count from resource_occupancies where resource_id = ${resource.id} and status = 'cleaning'`;
  if (resource.status !== 'cleaning' && !(resource.status === 'in_use' && (cleaning?.count ?? 0) > 0)) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: { reason: 'cleaning_not_started', status: resource.status },
    });
  }
  await tx`update resource_occupancies set status = 'released', released_at = now(),
      updated_by = ${ctx.membershipId}
    where resource_id = ${resource.id} and status = 'cleaning'`;
  const [active] = await tx<{ value: number }[]>`
    select count(*)::int as value from resource_occupancies
    where resource_id = ${resource.id} and status = 'in_use'`;
  const next = (active?.value ?? 0) > 0 ? 'in_use' : 'available';
  await tx`update resources set status = ${next} where id = ${resource.id}`;
  audit({ entityType: 'resource', entityId: resource.id,
          before: { status: resource.status }, after: { status: next, note: input.note ?? null } });
  return { resourceId: resource.id, status: next as 'available' | 'in_use' };
});

registerHandler(ticketMoveItemResource, async ({ input, ctx, tx, audit }) => {
  const [item] = await tx<{
    id: string; ticket_id: string; resource_id: string | null; started_at: string | null;
  }[]>`select id, ticket_id, resource_id, started_at from ticket_items
       where id = ${input.ticketItemId}`;
  if (!item) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'ticket_item' } });
  if (!item.started_at) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, { details: { reason: 'service_not_started' } });
  }
  const lockIds = [...new Set([item.resource_id, input.resourceId].filter((id): id is string => Boolean(id)))].sort();
  const resources = await tx<{ id: string; status: string; capacity: number }[]>`
    select id, status, capacity from resources
    where location_id = ${ctx.locationId} and id = any(${lockIds})
    order by id for update`;
  const target = resources.find((row) => row.id === input.resourceId);
  if (!target || ['maintenance','cleaning','cleaning_required'].includes(target.status)) {
    throw new AppError(ERROR_CODES.RESOURCE_CONFLICT, {
      details: { resourceId: input.resourceId, status: target?.status ?? 'missing' },
    });
  }
  const [usage] = await tx<{ active: number; dirty: number }[]>`
    select count(*) filter (where status = 'in_use')::int as active,
           count(*) filter (where status in ('cleaning_required','cleaning'))::int as dirty
    from resource_occupancies where resource_id = ${target.id} and status <> 'released'`;
  if ((usage?.active ?? 0) >= target.capacity || (usage?.dirty ?? 0) > 0) {
    throw new AppError(ERROR_CODES.RESOURCE_CONFLICT, {
      details: { resourceId: target.id, reason: 'resource_not_available' },
    });
  }
  await assertResourceStaffLimit(tx, target.id, item.id);
  if (item.resource_id) {
    await tx`update resource_occupancies set status = 'cleaning_required', updated_by = ${ctx.membershipId}
      where ticket_item_id = ${item.id} and resource_id = ${item.resource_id} and status = 'in_use'`;
    const [oldActive] = await tx<{ value: number }[]>`
      select count(*)::int as value from resource_occupancies
      where resource_id = ${item.resource_id} and status = 'in_use'`;
    await tx`update resources set status = ${(oldActive?.value ?? 0) > 0 ? 'in_use' : 'cleaning_required'}
      where id = ${item.resource_id}`;
  }
  await tx`insert into resource_occupancies
    (org_id, location_id, resource_id, ticket_item_id, status, updated_by)
    values (${ctx.orgId}, ${ctx.locationId}, ${target.id}, ${item.id}, 'in_use', ${ctx.membershipId})
    on conflict (ticket_item_id, resource_id) do update set status = 'in_use', released_at = null,
      updated_by = excluded.updated_by`;
  await tx`update ticket_items set resource_id = ${target.id} where id = ${item.id}`;
  await tx`update resources set status = 'in_use' where id = ${target.id}`;
  audit({ entityType: 'ticket', entityId: item.ticket_id,
          after: { action: 'move_resource', ticketItemId: item.id,
                   fromResourceId: item.resource_id, toResourceId: target.id, reason: input.reason } });
  return { ticketItemId: item.id, resourceId: target.id };
});

// ─────────────────────────────────────────────────────────── resource.save

registerHandler(resourceSave, async ({ input, ctx, tx, audit }) => {
  let typeId = input.resourceTypeId;
  if (!typeId) {
    const typeKey = (input.type || 'room').toLowerCase();
    const [existingType] = await tx<{ id: string }[]>`
      select id from resource_types
      where location_id = ${ctx.locationId} and key = ${typeKey}
      limit 1`;
    if (existingType) {
      typeId = existingType.id;
    } else {
      const [newType] = await tx<{ id: string }[]>`
        insert into resource_types (org_id, location_id, key, name)
        values (${ctx.orgId}, ${ctx.locationId}, ${typeKey}, ${jsonb({ en: input.type, 'zh-Hans': input.type })}::jsonb)
        returning id`;
      typeId = newType!.id;
    }
  }

  if (input.resourceId) {
    const [res] = await tx<{ id: string }[]>`
      select id from resources
      where id = ${input.resourceId} and location_id = ${ctx.locationId} for update`;
    if (!res) {
      throw new AppError(ERROR_CODES.NOT_FOUND, {
        details: { entity: 'resource', id: input.resourceId },
      });
    }

    const [occupied] = await tx<{ count: number }[]>`select count(*)::int as count from resource_occupancies
      where resource_id = ${input.resourceId} and status <> 'released'`;
    if (input.capacity < (occupied?.count ?? 0)) throw new AppError(ERROR_CODES.RESOURCE_CONFLICT, { details: { reason: 'capacity_below_current_occupancy' } });
    const [before] = await tx<Record<string, unknown>[]>`
      select name, resource_type_id, capacity, max_staff, status from resources
      where id = ${input.resourceId}`;

    await tx`
      update resources set
        name = ${input.name},
        resource_type_id = ${typeId},
        capacity = ${input.capacity},
        max_staff = ${input.maxStaff ?? null}
      where id = ${input.resourceId} and location_id = ${ctx.locationId}`;

    const [after] = await tx<Record<string, unknown>[]>`
      select name, resource_type_id, capacity, max_staff, status from resources
      where id = ${input.resourceId}`;

    audit({
      entityType: 'resource',
      entityId: input.resourceId,
      before: before ?? {},
      after: after ?? {},
    });

    return { resourceId: input.resourceId, created: false };
  }

  // 新建资源
  const [created] = await tx<{ id: string }[]>`
    insert into resources (
      org_id, location_id, resource_type_id, name, capacity, max_staff, status
    ) values (
      ${ctx.orgId}, ${ctx.locationId}, ${typeId}, ${input.name},
      ${input.capacity}, ${input.maxStaff ?? null}, 'available'
    )
    returning id`;

  const [after] = await tx<Record<string, unknown>[]>`
    select name, resource_type_id, capacity, max_staff, status from resources
    where id = ${created!.id}`;

  audit({
    entityType: 'resource',
    entityId: created!.id,
    before: {},
    after: after ?? {},
  });

  return { resourceId: created!.id, created: true };
});

// ─────────────────────────────────────────────────────────── resource.delete

registerHandler(resourceDelete, async ({ input, ctx, tx, audit }) => {
  const [res] = await tx<{ id: string; name: string; status: string }[]>`
    select id, name, status from resources
    where id = ${input.resourceId} and location_id = ${ctx.locationId}`;
  if (!res) {
    throw new AppError(ERROR_CODES.NOT_FOUND, {
      details: { entity: 'resource', id: input.resourceId },
    });
  }

  // 检查是否有未完成的预约正在占用该工位
  if (!input.force) {
    const [active] = await tx<{ count: number }[]>`
      select count(*)::int as count from appointment_items
      where location_id = ${ctx.locationId}
        and resource_id = ${input.resourceId}
        and status not in ('cancelled', 'completed', 'no_show')
        and ends_at >= now() - interval '10 minutes'`;
    if (active && active.count > 0) {
      throw new AppError(ERROR_CODES.RESOURCE_CONFLICT, {
        messageKey: 'error.RESOURCE_IN_USE',
        details: {
          reason: 'RESOURCE_IN_USE',
          activeAppointments: active.count,
          message: '该工位当前有正在进行或待履约的预约，无法直接删除。请先调整预约或将工位设为停用。',
        },
      });
    }
  }

  // 解除历史预约中的外键绑定，保留历史单据完整
  await tx`
    update appointment_items
    set resource_id = null
    where location_id = ${ctx.locationId} and resource_id = ${input.resourceId}`;

  // 删除资源
  await tx`
    delete from resources
    where id = ${input.resourceId} and location_id = ${ctx.locationId}`;

  audit({
    entityType: 'resource',
    entityId: input.resourceId,
    before: res,
    after: { deleted: true },
  });

  return { resourceId: input.resourceId, deleted: true };
});
