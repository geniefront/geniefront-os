import { measure } from "./segments";
const ascii = (value: string) =>
  value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7e]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const short = (value: string, n: number) => ascii(value).slice(0, n).trim();
export function compactWhen(iso: string, tz: string): string {
  const date = new Date(iso);
  return `${new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric" }).format(date)} ${new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true }).format(date).replace(":00", "").replace(/\s/g, "").toLowerCase()}`;
}
const cleanWhen = (text: string) =>
  ascii(text)
    .replace(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat),? /, "")
    .replace(/, /g, " ")
    .replace(/:00\s*(AM|PM)/g, (_, p) => p.toLowerCase())
    .replace(/\s+(AM|PM)/g, (_, p) => p.toLowerCase());
export function customerBookingSms(args: {
  event: "confirmed" | "changed" | "cancelled" | "reminder";
  shop: string;
  when: string;
  service?: string;
  preferredStaff?: string | undefined;
  hasEmail?: boolean | undefined;
}): string {
  let shop = short(args.shop, 32) || "Your store",
    service = short(args.service ?? "", 35),
    staff = short(args.preferredStaff ?? "", 16);
  const state = {
    confirmed: "Confirmed",
    changed: "Rescheduled to",
    cancelled: "Canceled",
    reminder: "Reminder",
  }[args.event];
  const tail = args.hasEmail
    ? "Manage via email or call store."
    : "Questions? Call store.";
  const build = () =>
    `GenieFront: ${shop}. ${state} ${cleanWhen(args.when)}.${service ? ` ${service}.` : ""}${staff ? ` With ${staff}.` : ""} ${tail} Reply STOP to opt out.`;
  while (measure(build()).units > 160 && service.length)
    service = service.slice(0, -1).trimEnd();
  while (measure(build()).units > 160 && staff.length)
    staff = staff.slice(0, -1).trimEnd();
  while (measure(build()).units > 160 && shop.length > 8)
    shop = shop.slice(0, -1).trimEnd();
  return build();
}
export function shopBookingSms(args: {
  event: "created" | "changed" | "cancelled";
  customer: string;
  when: string;
  oldWhen?: string | undefined;
  guests: number;
  preferredStaff?: string | undefined;
  link: string;
}): string {
  let name = short(args.customer, 20) || "Guest",
    staff = short(args.preferredStaff ?? "", 16);
  const state = { created: "NEW", changed: "CHANGED", cancelled: "CANCELED" }[
    args.event
  ];
  // HTTPS is restored by mobile link detection; keep the full link target intact.
  const link = args.link.replace(/^https:\/\//, "");
  let old = args.oldWhen ? cleanWhen(args.oldWhen) : "";
  const build = () =>
    `GenieFront: ${state} ${name}. ${old ? `${old} -> ` : ""}${cleanWhen(args.when)}. ${args.guests} guest${args.guests === 1 ? "" : "s"}.${staff ? ` With ${staff}.` : ""} ${link} Reply STOP to opt out.`;
  while (measure(build()).units > 160 && staff.length)
    staff = staff.slice(0, -1).trimEnd();
  while (measure(build()).units > 160 && name.length > 5)
    name = name.slice(0, -1).trimEnd();
  if (measure(build()).units > 160) old = "";
  return build();
}
