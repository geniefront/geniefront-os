/**
 * 预约抽屉生命周期步进器。
 *
 * 日历色块看的是 item.status（booked / in_service / done），
 * 抽屉若把不认识的 appointment.status 回落到上一次打开留下的 initialStatus，
 * 就会把一张预约卡画成四步全勾。未知状态一律按已预约。
 */

export type AppointmentStepperRank = 1 | 2 | 3 | 4;

export function appointmentStepperRank(
  status: string | null | undefined,
  items?: Array<{ status?: string | null }>,
): AppointmentStepperRank {
  const itemStatuses = (items ?? []).map((item) => item.status).filter((s): s is string => Boolean(s));
  if (itemStatuses.some((s) => s === 'in_service')) return 3;
  if (itemStatuses.length > 0 && itemStatuses.every((s) => s === 'done' || s === 'completed')) return 4;
  if (itemStatuses.some((s) => s === 'booked' || s === 'checked_in')
    && (status === 'completed' || status === 'done')) {
    return itemStatuses.some((s) => s === 'checked_in') ? 2 : 1;
  }
  switch (status) {
    case 'done':
    case 'completed':
      return 4;
    case 'in_service':
      return 3;
    case 'checked_in':
    case 'waiting':
      return 2;
    case 'booked':
    default:
      return 1;
  }
}
