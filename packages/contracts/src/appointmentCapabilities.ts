/** Shared scheduling actions; unknown states are read-only. */
export function appointmentAllowsSchedulingChanges(status: string | null | undefined): boolean {
  return ['booked', 'checked_in', 'waiting', 'in_service'].includes(status ?? '');
}
