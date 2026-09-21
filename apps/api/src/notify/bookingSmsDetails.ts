import type postgres from 'postgres';
import { pickText } from '@gf/contracts';
import { notificationCopy } from './copy';
import type { OwnerLocale } from '../email/locale';
export interface SmsServiceRow {
  id:string;name:unknown;short_names:Record<string,string>;duration_min:number;is_addon:boolean;
  addon_ids:string[];membership_id:string|null;details:Record<string,unknown>;
}
export interface SmsAddon {id:string;name:unknown;short_names:Record<string,string>;duration_min:number}
export function smsServiceName(name:unknown,shortNames:Record<string,string>,locale:OwnerLocale):string {
  const stored=shortNames[locale]?.trim();
  if(stored)return stored;
  return pickText(name,locale,notificationCopy(locale).service);
}
export function renderSmsServices(rows:SmsServiceRow[],addons:SmsAddon[],locale:OwnerLocale,partySize:number,membershipId?:string):string {
  const groups=new Map<number,string[]>(),seen=new Set<string>();
  const unit=locale.startsWith('zh')?'分':locale==='ko'?'분':locale==='vi'?'ph':'min';
  for(const row of rows) {
    if(membershipId&&row.membership_id!==membershipId)continue;
    const raw=Number(row.details.publicGuestIndex??0),guest=Number.isInteger(raw)&&raw>=0?raw:0;
    // Multiple staff fulfilling one service must not duplicate it in the shop notice.
    const execution=String(row.details.serviceExecutionGroup??row.id)+':'+guest;
    if(seen.has(execution))continue;seen.add(execution);
    // Add-ons live on the first staff row of a shared execution. Show that same
    // service to every assigned staff member without duplicating it for the shop.
    const source=row.details.serviceExecutionGroup ? rows.find(r=>
      r.details.serviceExecutionGroup===row.details.serviceExecutionGroup &&
      Number(r.details.publicGuestIndex??0)===guest && r.addon_ids.length) ?? row : row;
    const extra=source.addon_ids.map(id=>addons.find(a=>a.id===id)).filter((a):a is SmsAddon=>!!a);
    const name=smsServiceName(row.name,row.short_names,locale);
    const suffix=extra.map(a=>'+'+smsServiceName(a.name,a.short_names,locale)).join('');
    const base=source.details.smsBaseDurationMin;
    // Never derive historical duration from today's mutable add-on catalog.
    // Legacy bookings show the booked total after the combined service names.
    const hasBase=typeof base==='number' && Number.isFinite(base) && base>=0 && base<=row.duration_min;
    const label=row.is_addon ? name+suffix : hasBase
      ? `${name}${base}${unit}${suffix}`
      : `${suffix ? `(${name}${suffix})` : name}${row.duration_min}${unit}`;
    groups.set(guest,[...(groups.get(guest)??[]),label]);
  }
  return [...groups.entries()].sort(([a],[b])=>a-b).map(([guest,items])=>(partySize>1?`${guest+1}:`:'')+items.join('+')).join('; ');
}
export async function loadBookingSmsServices(tx:postgres.TransactionSql,locationId:string,appointmentId:string) {
  const rows=await tx<SmsServiceRow[]>`
    select ai.id,s.name,s.short_names,s.is_addon,ai.duration_min,ai.addon_ids,ai.membership_id,ai.details
    from appointment_items ai join services s on s.id=ai.service_id
    where ai.appointment_id=${appointmentId} and ai.location_id=${locationId}
      and (ai.status<>'cancelled' or exists(select 1 from appointments a where a.id=ai.appointment_id and a.status='cancelled'))
    order by ai.seq,ai.id`;
  const ids=[...new Set(rows.flatMap(r=>r.addon_ids))];
  const addons=ids.length?await tx<SmsAddon[]>`select id,name,short_names,duration_min from services where location_id=${locationId} and id=any(${ids})`:[];
  return {rows,addons};
}
