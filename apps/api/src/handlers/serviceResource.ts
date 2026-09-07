import type postgres from 'postgres';
import { AppError, ERROR_CODES, type CommandContext } from '@gf/contracts';
import { assertResourceStaffLimit } from '../resourceStaffLimit';

/** A guest occupies one seat even when several items share the same resource. */
export async function occupyServiceResource(
  tx: postgres.TransactionSql, ctx: CommandContext,
  item: { id: string; ticket_id: string; resource_id: string | null },
  reopen = false,
): Promise<void> {
  if (!item.resource_id) return;
  const [resource] = await tx<{ status: string; capacity: number }[]>`
    select status, capacity from resources
    where id = ${item.resource_id} and location_id = ${ctx.locationId} for update`;
  const [usage] = await tx<{ active: number; dirty: number; own_active: number }[]>`
    select count(distinct ti.ticket_id) filter (where ro.status = 'in_use')::int as active,
           count(*) filter (where ro.status = 'cleaning'
             or (ro.status = 'cleaning_required'
               and (ti.ticket_id <> ${item.ticket_id} or not ${reopen})))::int as dirty,
           count(*) filter (where ro.status = 'in_use' and ti.ticket_id = ${item.ticket_id})::int as own_active
    from resource_occupancies ro join ticket_items ti on ti.id = ro.ticket_item_id
    where ro.resource_id = ${item.resource_id} and ro.status <> 'released'`;
  if (!resource || ['maintenance', 'cleaning'].includes(resource.status)
    || (!reopen && resource.status === 'cleaning_required')
    || (usage?.dirty ?? 0) > 0
    || ((usage?.own_active ?? 0) === 0 && (usage?.active ?? 0) >= resource.capacity)) {
    throw new AppError(ERROR_CODES.RESOURCE_CONFLICT, {
      details: { reason: 'resource_not_available', resourceId: item.resource_id },
    });
  }
  await assertResourceStaffLimit(tx, item.resource_id, item.id);
  await tx`insert into resource_occupancies
    (org_id, location_id, resource_id, ticket_item_id, status, updated_by)
    values (${ctx.orgId}, ${ctx.locationId}, ${item.resource_id}, ${item.id}, 'in_use', ${ctx.membershipId})
    on conflict (ticket_item_id, resource_id) do update set status = 'in_use',
      released_at = null, updated_by = excluded.updated_by`;
  await tx`update resources set status = 'in_use' where id = ${item.resource_id}`;
}
