/**
 * 房间与工位资源命令处理器（02-DATA-MODEL §7，P0 房态看板）
 */

import {
  resourceSetStatus, resourceSave, resourceDelete, AppError, ERROR_CODES,
} from '@gf/contracts';
import { jsonb } from '@gf/db';
import { registerHandler } from '../bus';

// ─────────────────────────────────────────────────────────── resource.setStatus

registerHandler(resourceSetStatus, async ({ input, ctx, tx, audit }) => {
  const [res] = await tx<{ id: string; status: string; name: string }[]>`
    select id, status, name from resources
    where id = ${input.resourceId} and location_id = ${ctx.locationId}`;
  if (!res) {
    throw new AppError(ERROR_CODES.NOT_FOUND, {
      details: { entity: 'resource', id: input.resourceId },
    });
  }

  const before = { status: res.status, name: res.name };

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
      where id = ${input.resourceId} and location_id = ${ctx.locationId}`;
    if (!res) {
      throw new AppError(ERROR_CODES.NOT_FOUND, {
        details: { entity: 'resource', id: input.resourceId },
      });
    }

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

