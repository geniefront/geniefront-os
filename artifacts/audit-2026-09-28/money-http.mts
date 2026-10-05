import {writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {buildServer} from '../../apps/api/src/server.ts';
import {issueStaffSession} from '../../apps/api/src/auth/staffSession.ts';
import {adminSql} from '../../packages/db/src/admin.ts';
import {closeDb} from '../../packages/db/src/client.ts';
const results:any={};
const [owner]=await adminSql`select m.id,m.org_id,m.location_id from memberships m join membership_roles mr on mr.membership_id=m.id join roles r on r.id=mr.role_id where m.location_id='bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb' and r.key='owner' limit 1`;
const [tech]=await adminSql`select membership_id as id from staff_profiles where location_id=${owner.location_id} and is_bookable=true limit 1`;
const [svc]=await adminSql`select id,base_price_cents from services where location_id=${owner.location_id} and active and not is_addon and staff_count=1 order by base_price_cents limit 1`;
const session=await issueStaffSession({orgId:owner.org_id,locationId:owner.location_id,membershipId:owner.id},'claim_code','audit-money');
const app=buildServer();
async function cmd(name:string,input:any,key=randomUUID()){
 const r=await app.inject({method:'POST',url:`/v1/commands/${name}`,headers:{'x-staff-token':session.token,'idempotency-key':key},payload:{input}});return {status:r.statusCode,...r.json()};
}
try{
 const opened=await cmd('ticket.open',{customerId:null,walkInName:'AUDIT MONEY',items:[{serviceId:svc.id,membershipId:tech.id}]});
 results.open=opened; if(!opened.result)throw new Error('open failed');
 const id=opened.result.ticketId;
 // Service execution uses the real command; no direct mutation of payment state.
 results.finish=await cmd('ticket.finishItem',{ticketItemId:opened.result.ticketItemIds[0]});
 const amount=opened.result.subtotalCents;
 const wrong=await cmd('ticket.close',{ticketId:id,payments:[{method:'cash',amountCents:1}]});
 const [before]=await adminSql`select count(*)::int as n from payments where ticket_id=${id}`;
 results.mismatch={status:wrong.status,code:wrong.code,paymentRows:before.n};
 const key=randomUUID();const payload={ticketId:id,payments:[{method:'cash',amountCents:Math.floor(amount/2)},{method:'card',amountCents:amount-Math.floor(amount/2)+100,tipCents:100}]};
 results.close=await cmd('ticket.close',payload,key);
 results.repeat=await cmd('ticket.close',payload,key);
 results.secondKey=await cmd('ticket.close',payload);
 const part=Math.floor(amount/3);const refundKey=randomUUID();
 results.partialRefund=await cmd('ticket.refund',{ticketId:id,refundAmountCents:part,reason:'wrong_charge'},refundKey);
 results.refundReplay=await cmd('ticket.refund',{ticketId:id,refundAmountCents:part,reason:'wrong_charge'},refundKey);
 results.overRefund=await cmd('ticket.refund',{ticketId:id,refundAmountCents:amount+1,reason:'wrong_charge'});
 results.finalRefund=await cmd('ticket.refund',{ticketId:id,refundAmountCents:amount-part+100,refundTipCents:100,reason:'wrong_charge'});
 const [totals]=await adminSql`select t.status,t.total_cents,t.refund_cents,(select sum(amount_cents)::int from payments where ticket_id=t.id) as payments,(select sum(tip_cents)::int from payments where ticket_id=t.id) as tips,(select sum(amount_cents)::int from ticket_refunds where ticket_id=t.id) as refunds,(select count(*)::int from ticket_refunds where ticket_id=t.id) as refund_rows from tickets t where id=${id}`;
 results.totals=totals;
}finally{writeFileSync(new URL('./money-http.json',import.meta.url),JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2));await app.close();await closeDb();await adminSql.end();}
