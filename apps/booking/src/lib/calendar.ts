import type { Shop } from "./api";
const escape = (text: string) =>
  text
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
const stamp = (value: string) =>
  new Date(value)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
export function calendarHref(
  booking: { bookingId: string; startsAt: string; endsAt: string },
  shop: Shop,
): string {
  const address =
    typeof shop.address === "string"
      ? shop.address
      : Object.values(shop.address ?? {})
          .filter(Boolean)
          .join(", ");
  const text = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//GenieFront//Booking//EN",
    "BEGIN:VEVENT",
    `UID:${escape(booking.bookingId)}@geniefront`,
    `DTSTAMP:${stamp(new Date().toISOString())}`,
    `DTSTART:${stamp(booking.startsAt)}`,
    `DTEND:${stamp(booking.endsAt)}`,
    `SUMMARY:${escape(`Appointment at ${shop.name}`)}`,
    `LOCATION:${escape(address)}`,
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
  return `data:text/calendar;charset=utf-8,${encodeURIComponent(text)}`;
}
