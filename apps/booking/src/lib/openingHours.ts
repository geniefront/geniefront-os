import {hourPeriods} from '@gf/scheduling';
/** Local wall-clock hours, including the previous day's overnight opening. */
export function isShopOpen(
  hours: Record<string, { open: string; close: string; periods?: Array<{open:string;close:string}> } | null>,
  timezone: string,
  now = new Date(),
): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const day = parts.find((p) => p.type === "weekday")!.value.toLowerCase();
  const keys = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const minute =
    Number(parts.find((p) => p.type === "hour")!.value) * 60 +
    Number(parts.find((p) => p.type === "minute")!.value);
  const value = (s: string) => {
    const [h, m] = s.split(":").map(Number);
    return h! * 60 + m!;
  };
  const today = hours[day],
    previous = hours[keys[(keys.indexOf(day) + 6) % 7]!];
  return hourPeriods(today).some(p=>{const open=value(p.open),close=value(p.close);return close>open?minute>=open&&minute<close:minute>=open;}) || hourPeriods(previous).some(p=>value(p.close)<=value(p.open)&&minute<value(p.close));
}
