import type postgres from 'postgres';
import { AppError, ERROR_CODES } from '@gf/contracts';

/** Caller holds the resource row lock, so concurrent starts cannot both pass. */
export async function assertResourceStaffLimit(tx: postgres.TransactionSql, resourceId: string, ticketItemId: string) {
  const [resource] = await tx<{ max_staff: number | null }[]>`select max_staff from resources where id = ${resourceId}`;
  if (resource?.max_staff == null) return;
  const [usage] = await tx<{ count: number }[]>`select count(distinct tis.membership_id)::int as count
    from ticket_item_staff tis where tis.ticket_item_id = ${ticketItemId}
      or exists (select 1 from resource_occupancies ro where ro.ticket_item_id = tis.ticket_item_id
        and ro.resource_id = ${resourceId} and ro.status = 'in_use')`;
  if ((usage?.count ?? 0) > resource.max_staff) {
    throw new AppError(ERROR_CODES.RESOURCE_CONFLICT, { details: { reason: 'resource_staff_limit', resourceId, maxStaff: resource.max_staff } });
  }
}
