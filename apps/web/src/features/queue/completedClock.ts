import { formatIsoWallClock } from '@/lib/time';

/**
 * 看板已结卡上的「已完工 (HH:mm)」。
 *
 * 预约 ends_at 是排班结束点。客人提前下床时，必须用 ticket_items.finished_at。
 */
export function completedCardClock(input: {
  completedAt?: string | null;
  endTime: string;
  timezone: string;
}): string {
  if (input.completedAt) return formatIsoWallClock(input.completedAt, input.timezone);
  return input.endTime;
}
