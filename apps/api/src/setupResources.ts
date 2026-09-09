import type postgres from 'postgres';
import { AppError, ERROR_CODES } from '@gf/contracts';

export const ACTIVE_ROOM_TYPE_KEYS = ['room', 'vip', 'couples_room'] as const;
export const ACTIVE_RESOURCE_STATUSES = [
  'available', 'in_service', 'in_use', 'cleaning_required', 'cleaning',
] as const;

/** Serializes launch and every resource mutation that can change room readiness. */
export async function lockSetupResources(
  tx: postgres.TransactionSql,
  locationId: string,
): Promise<void> {
  await tx`select pg_advisory_xact_lock(hashtext(${`setup-resources:${locationId}`}))`;
}

export async function countActiveRooms(
  tx: postgres.TransactionSql,
  locationId: string,
): Promise<number> {
  const [row] = await tx<{ count: number }[]>`
    select count(*)::int as count
    from resources r
    join resource_types rt on rt.id = r.resource_type_id
      and rt.location_id = r.location_id
      and rt.org_id = r.org_id
    where r.location_id = ${locationId}
      and r.capacity > 0
      and rt.key = any(${[...ACTIVE_ROOM_TYPE_KEYS]})
      and r.status = any(${[...ACTIVE_RESOURCE_STATUSES]})`;
  return row?.count ?? 0;
}

/**
 * Existing active stores that already have no valid room remain usable and may
 * be repaired. A mutation is rejected only when it takes a healthy active store
 * from at least one valid room to zero.
 */
export async function assertActiveRoomNotRemoved(
  tx: postgres.TransactionSql,
  locationId: string,
  beforeCount: number,
): Promise<void> {
  if (beforeCount < 1) return;
  const [location] = await tx<{ status: string }[]>`
    select status from locations where id = ${locationId}`;
  if (location?.status !== 'active') return;
  if (await countActiveRooms(tx, locationId) > 0) return;
  throw new AppError(ERROR_CODES.RESOURCE_CONFLICT, {
    details: { reason: 'last_active_room', stepId: 'rooms' },
  });
}
