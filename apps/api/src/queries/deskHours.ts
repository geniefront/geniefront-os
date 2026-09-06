/**
 * 前台日快照的营业起止分钟。
 *
 * `/v1/desk/days` 已经走 `dayWindow`（跨午夜 closeMin > 1440），
 * `/v1/desk/day` 不能自己再 parse 一遍把周六 01:00 收成 60。
 */
import { dayWindow, type WeeklyHours } from '@gf/scheduling';

const FALLBACK_OPEN = 9 * 60;
const FALLBACK_CLOSE = 20 * 60;

export function deskOpenCloseMin(
  businessDate: string,
  hours: unknown,
): { openMin: number; closeMin: number } {
  const win = dayWindow(businessDate, hours as WeeklyHours | null | undefined);
  if (!win) {
    return { openMin: FALLBACK_OPEN, closeMin: FALLBACK_CLOSE };
  }
  return { openMin: win.openMin, closeMin: win.closeMin };
}
