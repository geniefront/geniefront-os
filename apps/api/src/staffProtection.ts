import type postgres from 'postgres';
import { AppError, ERROR_CODES, type CommandContext } from '@gf/contracts';
import { lockBookingCapacity } from './handlers/appointment';

export async function assertCanDeactivateStaff(tx: postgres.TransactionSql, ctx: CommandContext, membershipId: string) {
  await lockBookingCapacity(tx, ctx.locationId);
  const [member] = await tx<{protected:boolean}[]>`select (m.id=${ctx.membershipId} or m.user_id=${ctx.userId} or m.user_id=o.owner_user_id or exists(select 1 from membership_roles mr join roles r on r.id=mr.role_id where mr.membership_id=m.id and r.key='owner')) as protected from memberships m join organizations o on o.id=m.org_id where m.id=${membershipId} and m.location_id=${ctx.locationId} for update of m`;
  if (!member) throw new AppError(ERROR_CODES.NOT_FOUND);
  if (member.protected) throw new AppError(ERROR_CODES.VALIDATION_FAILED,{details:{reason:'protected_owner_or_self'}});
  const [future] = await tx`select ai.id from appointment_items ai join appointments a on a.id=ai.appointment_id where a.location_id=${ctx.locationId} and coalesce(ai.membership_id,ai.reserved_membership_id)=${membershipId} and ai.ends_at>now() and ai.status not in ('cancelled','no_show','completed') and a.status not in ('cancelled','no_show','completed') limit 1`;
  if (future) throw new AppError(ERROR_CODES.VALIDATION_FAILED,{details:{reason:'staff_has_upcoming_appointments'}});
}
