import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { buildServer } from '../../apps/api/src/server.ts';
import { issueStaffSession, staffContextFromToken } from '../../apps/api/src/auth/staffSession.ts';
import { adminSql } from '../../packages/db/src/admin.ts';
import { sql, closeDb } from '../../packages/db/src/client.ts';
const results:any = {};
const [member] = await adminSql`select m.id,m.org_id,m.location_id from memberships m join staff_profiles sp on sp.membership_id=m.id where sp.display_name->>'en'='Linh'`;
const [other] = await adminSql`select m.id from memberships m join staff_profiles sp on sp.membership_id=m.id where m.location_id=${member.location_id} and m.id<>${member.id} and sp.is_bookable=true limit 1`;
const [service] = await adminSql`select id,base_price_cents from services where location_id=${member.location_id} and active and not is_addon and staff_count=1 and base_price_cents>0 limit 1`;
const issued = await issueStaffSession({orgId:member.org_id,locationId:member.location_id,membershipId:member.id},'claim_code','audit-extended');
const ctx=await staffContextFromToken(issued.token);
results.permissions=[...ctx.permissions].sort();
const app=buildServer();
const headers={'x-staff-token':issued.token};
const openInput=(name:string,price?:number,staff=member.id)=>({customerId:null,walkInName:name,items:[{serviceId:service.id,membershipId:staff,...(price===undefined?{}:{priceCentsOverride:price})}]});
async function command(name:string,input:any,key=randomUUID()) {
 const r=await app.inject({method:'POST',url:`/v1/commands/${name}`,headers:{...headers,'idempotency-key':key},payload:{input}});
 const j=r.json(); return {status:r.statusCode,...j};
}
try {
 results.prices=[];
 for(const price of [undefined,0,-100,service.base_price_cents,service.base_price_cents+100]) {
  const r=await command('ticket.open',openInput(`AUDIT price ${price}`,price));
  results.prices.push({price:price??'catalog',status:r.status,subtotal:r.result?.subtotalCents,error:r.error});
 }
 const first=await command('ticket.open',openInput('AUDIT add'));
 results.addItem=await command('ticket.addItem',{ticketId:first.result.ticketId,serviceId:service.id,membershipId:member.id,priceCentsOverride:0});
 const key=randomUUID();
 const a=await command('ticket.open',openInput('AUDIT customer A'),key);
 const replay=await command('ticket.open',openInput('AUDIT customer A'),key);
 const changed=await command('ticket.open',openInput('AUDIT customer B'),key);
 const [saved]=await adminSql`select walk_in_name from tickets where id=${a.result.ticketId}`;
 results.idempotency={firstStatus:a.status,samePayloadStatus:replay.status,samePayloadReplayed:replay.replayed,changedStatus:changed.status,changedReplayed:changed.replayed,sameTicket:a.result.ticketId===changed.result.ticketId,storedName:saved.walk_in_name};
 const [foreignCustomer]=await adminSql`select id,org_id from customers where org_id<>${member.org_id} limit 1`;
 const cross=await command('ticket.open',{...openInput('AUDIT cross customer'),customerId:foreignCustomer.id});
 results.crossCustomer={status:cross.status,error:cross.error};
 if(cross.result?.ticketId){const [r]=await adminSql`select t.org_id<>c.org_id as crosses_org from tickets t join customers c on c.id=t.customer_id where t.id=${cross.result.ticketId}`; results.crossCustomer.persistedCrossOrg=r.crosses_org;}
 const [foreignSvc]=await adminSql`select id from services where location_id<>${member.location_id} limit 1`;
 results.crossService=await command('ticket.open',{...openInput('AUDIT forbidden service'),items:[{serviceId:foreignSvc.id,membershipId:member.id}]});
 const ticketOther=await command('ticket.open',openInput('AUDIT other staff',undefined,other.id));
 if(ticketOther.result?.ticketId) results.otherTicketAdd=await command('ticket.addItem',{ticketId:ticketOther.result.ticketId,serviceId:service.id,membershipId:other.id,priceCentsOverride:0});
 results.orderFilters=[];
 for(const staffId of [undefined,member.id,other.id]){
 const r=await app.inject({method:'GET',url:'/v1/desk/orders'+(staffId?`?staffId=${staffId}`:''),headers}); const rows=r.json().rows??[];
 results.orderFilters.push({filter:staffId===undefined?'omitted':staffId===member.id?'self':'other',status:r.statusCode,rows:rows.length,otherStaffOrders:rows.filter((x:any)=>x.items?.length&&x.items.every((i:any)=>i.membershipId!==member.id)).length});
 }
 // Real HTTP request is stopped at the database advisory lock AFTER authentication.
 const raceKey=randomUUID(); let release!:()=>void; let acquired!:()=>void;
 const gotLock=new Promise<void>(r=>acquired=r), unlock=new Promise<void>(r=>release=r);
 const holder=sql.begin(async tx=>{await tx`select pg_advisory_xact_lock(hashtext(${member.location_id}),hashtext(${raceKey}))`; acquired(); await unlock;});
 await gotLock;
 const pending=command('ticket.open',openInput('AUDIT revoked in flight'),raceKey);
 let waiting=false;
 try {
  for(let i=0;i<150;i++){
   const [row]=await adminSql`select count(*)::int as n from pg_stat_activity where usename='app_user' and wait_event='advisory'`;
   if(row.n>0){waiting=true;break;} await new Promise(r=>setTimeout(r,20));
  }
  if(!waiting) throw new Error('Barrier not reached');
  await adminSql`update staff_sessions set revoked_at=now() where id=${ctx.sessionId}`;
 }finally{release();await holder;}
 const response=await pending;
 const after=await command('ticket.open',openInput('AUDIT after revoked'));
 results.revocation={waitBarrierReached:waiting,inFlightStatus:response.status,ticketPersisted:Boolean(response.result?.ticketId),subsequentRequestStatus:after.status};
} finally {
 writeFileSync(new URL('./extended-http.json',import.meta.url),JSON.stringify(results,null,2));
 console.log(JSON.stringify(results,null,2));
 await app.close();await closeDb();await adminSql.end();
}
