/** Generated, reusable service illustrations. Merchant uploads take priority. */
export const BOOKING_MEDIA = [
  { id: "massage", en: "Massage", zh: "按摩" },
  { id: "nails", en: "Nails", zh: "美甲" },
  { id: "foot", en: "Foot massage", zh: "足疗" },
  { id: "spa", en: "Spa", zh: "SPA" },
  { id: "hot-stones", en: "Hot stones", zh: "热石" },
  { id: "table-shower", en: "Table shower", zh: "台上淋浴" },
  { id: "essential-oils", en: "Essential oils", zh: "精油" },
  { id: "couples", en: "Couples massage", zh: "情侣按摩" },
] as const;
export const bookingMediaUrl = (id: string) =>
  `https://book.geniefront.com/media/defaults/${id}-v1.jpg`;
export function defaultBookingMedia(name: string): string {
  const s = name.toLowerCase();
  const id = /hot.?stone|热石|熱石/.test(s)
    ? "hot-stones"
    : /shower|淋浴/.test(s)
      ? "table-shower"
      : /essential|aroma|精油/.test(s)
        ? "essential-oils"
        : /couple|情侣|情侶|双人|雙人/.test(s)
          ? "couples"
          : /foot|reflex|足/.test(s)
            ? "foot"
            : /nail|manicure|pedicure|美甲|指甲/.test(s)
              ? "nails"
              : /massage|swedish|deep tissue|按摩/.test(s)
                ? "massage"
                : "spa";
  return bookingMediaUrl(id);
}
