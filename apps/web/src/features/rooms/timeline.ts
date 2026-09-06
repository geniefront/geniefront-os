import { instantToWallDate, instantToWallMinutes } from '@/lib/time';

export function roomTimelineMinute(iso: string, timezone: string, businessDate: string): number {
  const date = instantToWallDate(iso, timezone);
  const days = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${businessDate}T00:00:00Z`)) / 86400000);
  return days * 1440 + instantToWallMinutes(iso, timezone);
}

export function roomTimelinePosition(start: number, end: number, from: number, to: number) {
  if (end <= from || start >= to || to <= from) return null;
  const left = Math.max(start, from);
  return { left: (left - from) / (to - from) * 100, width: (Math.min(end, to) - left) / (to - from) * 100 };
}
