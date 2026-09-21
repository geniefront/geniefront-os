import type postgres from 'postgres';
import { smsServiceName } from './serviceSmsName';
export { smsServiceName } from './serviceSmsName';
import type { OwnerLocale } from '../email/locale';
export interface SmsServiceRow {
  id:string;name:unknown;short_names:Record<string,string>;duration_min:number;is_addon:boolean;
  addon_ids:string[];membership_id:string|null;details:Record<string,unknown>;
}
export interface SmsAddon {id:string;name:unknown;short_names:Record<string,string>;duration_min:number}
export function renderSmsServices(rows:SmsServiceRow[],addons:SmsAddon[],locale:OwnerLocale,partySize:number,membershipId?:string):string {
  const groups=new Map<string,{guests:number[];items:string[]}>(),seen=new Set<string>();
  const unit=locale.startsWith('zh')?'分':locale==='ko'?'분':locale==='vi'?'ph':'min';
  const guestOf=(row:SmsServiceRow)=>{
    const n=Number(row.details.publicGuestIndex??0);
    return Number.isInteger(n)&&n>=0?n:0;
  };
  for(const row of rows) {
    if(membershipId&&row.membership_id!==membershipId)continue;
    const execution=String(row.details.serviceExecutionGroup??row.id);
    if(seen.has(execution))continue;seen.add(execution);
    const peers=row.details.serviceExecutionGroup ? rows.filter(r=>r.details.serviceExecutionGroup===row.details.serviceExecutionGroup) : [row];
    const guests=[...new Set(peers.filter(r=>!membershipId||r.membership_id===membershipId).map(guestOf))].sort((a,b)=>a-b);
    // A couples selection covers both guests; its add-ons and base duration are
    // stored on the first row, not independently on each therapist's row.
    const source=peers.find(r=>r.addon_ids.length)??peers[0]!;
    const extra=source.addon_ids.map(id=>addons.find(a=>a.id===id)).filter((a):a is SmsAddon=>!!a);
    const name=smsServiceName(source.name,source.short_names,locale);
    const suffix=extra.map(a=>'+'+smsServiceName(a.name,a.short_names,locale)).join('');
    const base=source.details.smsBaseDurationMin;
    const hasBase=typeof base==='number' && Number.isFinite(base) && base>=0 && base<=source.duration_min;
    const label=source.is_addon ? name+suffix : hasBase
      ? `${name}${base}${unit}${suffix}`
      : `${suffix ? `(${name}${suffix})` : name}${source.duration_min}${unit}`;
    const key=guests.join(',');
    groups.set(key,{guests,items:[...(groups.get(key)?.items??[]),label]});
  }
  return [...groups.values()].sort((a,b)=>a.guests[0]!-b.guests[0]!).map(({guests,items})=>
    (partySize>1?`${guests.map(g=>g+1).join(locale.startsWith('zh')?'、':',')}:`:'')+items.join('+')).join('; ');
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
