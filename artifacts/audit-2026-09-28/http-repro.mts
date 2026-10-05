import { buildServer } from '/Users/naiyouzhu/siteadmin/geniefront-os/apps/api/src/server.ts';
import { issueStaffSession, staffContextFromToken } from '/Users/naiyouzhu/siteadmin/geniefront-os/apps/api/src/auth/staffSession.ts';
import { adminSql } from '/Users/naiyouzhu/siteadmin/geniefront-os/packages/db/src/admin.ts';
import { closeDb } from '/Users/naiyouzhu/siteadmin/geniefront-os/packages/db/src/client.ts';
const [member] = await adminSql`select m.id,m.org_id,m.location_id from memberships m join staff_profiles sp on sp.membership_id=m.id where sp.display_name->>'en'='Linh'`;
const [service] = await adminSql`select id,base_price_cents from services where location_id=${member.location_id} and active and not is_addon and staff_count=1 and base_price_cents>0  limit 1`;
const issued = await issueStaffSession({orgId:member.org_id,locationId:member.location_id,membershipId:member.id},'claim_code','local-audit');
const ctx=await staffContextFromToken(issued.token);
const app=buildServer();
const headers={'x-staff-token':issued.token};
console.log('AUDIT_PERMISSIONS',JSON.stringify({ticketRead:ctx.permissions.has('ticket.read'),ticketWrite:ctx.permissions.has('ticket.write'),discount:ctx.permissions.has('ticket.discount'),report:ctx.permissions.has('report.view'),queueManage:ctx.permissions.has('queue.manage')}));
const orders=await app.inject({method:'GET',url:'/v1/desk/orders',headers});
const rows=orders.json().rows??[];
const others=rows.filter((r:any)=>r.items?.length && r.items.every((i:any)=>i.membershipId!==member.id));
console.log('AUDIT_ORDERS',JSON.stringify({status:orders.statusCode,rows:rows.length,otherStaffOrders:others.length,otherStaffAmountsExposed:others.some((o:any)=>typeof o.totalCents==='number'),cacheControl:orders.headers['cache-control']}));
const opened=await app.inject({method:'POST',url:'/v1/commands/ticket.open',headers:{...headers,'idempotency-key':'isolated-audit-price-override'},payload:{input:{customerId:null,walkInName:'AUDIT ONLY',items:[{serviceId:service.id,membershipId:member.id,priceCentsOverride:0}]}}});
console.log('AUDIT_PRICE_OVERRIDE',JSON.stringify({status:opened.statusCode,catalogPriceCents:service.base_price_cents,response:opened.json()}));
const [otherTicket]=await adminSql`select t.id from tickets t where location_id=${member.location_id} and status='in_service' and service_settled_at is null and not exists(select 1 from ticket_items ti join ticket_item_staff tis on tis.ticket_item_id=ti.id where ti.ticket_id=t.id and tis.membership_id=${member.id}) limit 1`;
if(otherTicket){
const added=await app.inject({method:'POST',url:'/v1/commands/ticket.addItem',headers:{...headers,'idempotency-key':'isolated-audit-other-ticket'},payload:{input:{ticketId:otherTicket.id,serviceId:service.id,membershipId:member.id,priceCentsOverride:0}}});
console.log('AUDIT_OTHER_TICKET_WRITE',JSON.stringify({status:added.statusCode,response:added.json()}));
}
await app.close();await closeDb();await adminSql.end();
