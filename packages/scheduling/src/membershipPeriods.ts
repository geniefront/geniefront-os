/** Calendar benefits stay anchored to the original local day; February must not shift later months. */
function wallParts(instant:Date,timezone:string):number[]{
 const p=new Intl.DateTimeFormat('en-US',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(instant);
 return ['year','month','day','hour','minute','second'].map(k=>Number(p.find(x=>x.type===k)!.value));
}
function wallStamp(parts:number[]):number{return Date.UTC(parts[0]!,parts[1]!-1,parts[2]!,parts[3]!,parts[4]!,parts[5]!);}
function resolveWall(parts:number[],timezone:string):Date{
 const target=wallStamp(parts),offsets=new Set<number>();
 for(let h=-36;h<=36;h+=6){const at=target+h*3600000;offsets.add(wallStamp(wallParts(new Date(at),timezone))-at);}
 const candidates=[...offsets].map(offset=>target-offset).sort((a,b)=>a-b);
 const exact=candidates.find(at=>wallStamp(wallParts(new Date(at),timezone))===target);
 if(exact!==undefined)return new Date(exact); // Earlier occurrence of an ambiguous wall time.
 const later=candidates.map(at=>({at,delta:wallStamp(wallParts(new Date(at),timezone))-target})).filter(x=>x.delta>0).sort((a,b)=>a.delta-b.delta||a.at-b.at)[0];
 if(!later||later.delta>3*3600000)throw new Error('membership_wall_time_unresolvable');
 return new Date(later.at); // Spring-forward gap: preserve minutes, move forward by the gap.
}
export function membershipCalendarMonth(anchor:Date,months:number,timezone:string):Date{
 if(!Number.isFinite(anchor.getTime())||!Number.isInteger(months)||months<0||months>1200)throw new Error('invalid_membership_anchor');
 if(months===0)return new Date(anchor);
 const p=wallParts(anchor,timezone),target=new Date(Date.UTC(p[0]!,p[1]!-1+months,1));
 p[0]=target.getUTCFullYear();p[1]=target.getUTCMonth()+1;p[2]=Math.min(p[2]!,new Date(Date.UTC(p[0]!,p[1]!,0)).getUTCDate());
 return resolveWall(p,timezone);
}
export interface MembershipPeriod {index:number;startsAt:string;endsAt:string;valueCents:number;}
export function membershipBenefitPeriods(input:{startsAt:string;endsAt:string;cadence:'month'|'year';benefitFrequency:'month'|'billing_period';amountCents:number;timezone:string}):MembershipPeriod[]{
 const start=new Date(input.startsAt),end=new Date(input.endsAt),duration=(end.getTime()-start.getTime())/86400000;
 if(!Number.isSafeInteger(input.amountCents)||input.amountCents<=0||!Number.isFinite(duration)
  ||(input.cadence==='month'?(duration<27||duration>32):(duration<364||duration>367)))throw new Error('invalid_membership_paid_period');
 const count=input.cadence==='year'&&input.benefitFrequency==='month'?12:1;
 const base=Math.floor(input.amountCents/count),remainder=input.amountCents%count;
 return Array.from({length:count},(_,index)=>{
  const s=index===0?start:membershipCalendarMonth(start,index,input.timezone);
  const e=index===count-1?end:new Date(Math.min(end.getTime(),membershipCalendarMonth(start,index+1,input.timezone).getTime()));
  if(e<=s)throw new Error('invalid_membership_benefit_period');
  return {index,startsAt:s.toISOString(),endsAt:e.toISOString(),valueCents:base+(index<remainder?1:0)};
 });
}
