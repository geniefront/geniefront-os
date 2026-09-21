import { notificationCopy } from '../notify/copy';
import { intlLocale, type OwnerLocale } from '../email/locale';
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
export function shopCompactWhen(iso:string,tz:string,locale:OwnerLocale):string {
  const d=new Date(iso);
  return new Intl.DateTimeFormat(intlLocale(locale),{timeZone:tz,month:'numeric',day:'numeric'}).format(d)
    + ' ' + new Intl.DateTimeFormat(intlLocale(locale),{timeZone:tz,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(d);
}
/** Preserve the entire phone and every service; Unicode and multi-part messages are intentional. */
export function shopBookingSms(args:{
  event:'created'|'changed'|'cancelled'|'assigned'|'pending'|'services_changed';
  locale?:OwnerLocale;customer:string;phone?:string|null|undefined;when:string;oldWhen?:string|undefined;
  guests?:number;services?:string;oldServices?:string;preferredStaff?:string|undefined;
}):string {
  const locale=args.locale??'en',c=notificationCopy(locale),sep=locale==='en'?' | ':'｜';
  const clean=(s:string)=>s.replace(/[\r\n\t]+/g,' ').trim();
  const phone=clean(args.phone??'').replace(/^\+1(?=\d{10}$)/,'');
  const who=[clean(args.customer||c.guest),phone].filter(Boolean).join(' ');
  const title=args.event==='services_changed'?c.servicesChanged:c[args.event];
  const head=`GF: ${title}${sep}${who}`+(args.guests===undefined?'':sep+(locale.startsWith('zh')?`${args.guests}人`:`${c.guests}: ${args.guests}`));
  const time=args.oldWhen&&args.oldWhen!==args.when?`${args.oldWhen}${locale==='en'?' -> ':'→'}${args.when}`:args.when;
  return [head,time,
    ...(args.oldServices?[`${c.previous}: ${args.oldServices}`,`${c.current}: ${args.services??''}`]:args.services?[args.services]:[]),
    ...(args.preferredStaff?[`${c.requested}: ${clean(args.preferredStaff)}`]:[]),
  ].join('\n');
}
export function shopCallSms(locale:OwnerLocale,phone:string):string {
  const c=notificationCopy(locale);
  return `GF: ${c.callDone}\n${c.caller}: ${phone.replace(/^\+1(?=\d{10}$)/,'') || c.unknown}`;
}
