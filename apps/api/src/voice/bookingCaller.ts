import type postgres from "postgres";
import { AppError, ERROR_CODES, type CommandContext } from "@gf/contracts";

/** Recheck ownership after the appointment lock, and hold the customer phone stable. */
export async function assertBookingCaller(
  tx: postgres.TransactionSql,
  ctx: CommandContext,
  appointmentId: string,
) {
  const caller = ctx.verifiedBookingCaller;
  if (!caller) return;
  const [row] = await tx<
    { phone: string; starts_at: string; self_reschedule_count: number }[]
  >`
  select c.phone_e164 as phone,a.starts_at::text,a.self_reschedule_count
  from appointments a join customers c on c.id=a.customer_id
  where a.id=${appointmentId} and a.location_id=${ctx.locationId}
    and a.source in ('web','phone_ai','phone_manual','desk') for share of c`;
  if (!row || row.phone !== caller.phoneE164)
    throw new AppError(ERROR_CODES.NOT_FOUND, {
      details: { entity: "booking" },
    });
  if (
    Date.parse(row.starts_at) !== Date.parse(caller.expectedStartsAt) ||
    row.self_reschedule_count !== caller.expectedRescheduleCount
  )
    throw new AppError(ERROR_CODES.RESOURCE_CONFLICT, {
      details: { reason: "booking_changed_query_again" },
    });
}
