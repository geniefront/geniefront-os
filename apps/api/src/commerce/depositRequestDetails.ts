import type {Tx,Ctx} from './model';
export async function depositRequestDetails(tx:Tx,ctx:Pick<Ctx,'locationId'>,holdId:string){
 const [row]=await tx<{order_id:string;purpose:'initial'|'replacement'|'supplement';state:string;expires_at:string;amount_cents:number;provider:string;checkout_url:string|null;payable:boolean}[]>`
  select r.order_id,r.purpose,r.state,r.expires_at::text,o.amount_cents,p.provider,p.checkout_url,
   r.state='open' and r.expires_at>now() and o.status='pending' and p.status='pending' and h.waived_at is null and not h.commerce_frozen
    and a.status in('booked','checked_in','in_service')
    and not exists(select 1 from tickets t where t.appointment_id=a.id and t.status<>'voided' and t.service_settled_at is not null) as payable
  from commerce_deposit_requests r join commerce_orders o on o.id=r.order_id join commerce_payments p on p.order_id=r.order_id
   join commerce_appointment_holds h on h.id=r.hold_id join appointments a on a.id=h.appointment_id
   left join commerce_deposit_requotes q on q.id=r.quote_id
  where r.hold_id=${holdId} and r.location_id=${ctx.locationId} order by coalesce(q.revision,0) desc,r.created_at desc,r.order_id desc limit 1`;
 if(!row)return null;
 return {orderId:row.order_id,purpose:row.purpose,state:row.state,expiresAt:new Date(row.expires_at).toISOString(),amountCents:row.amount_cents,
  channel:row.provider==='stripe'?'online' as const:'offline' as const,checkoutUrl:row.payable?row.checkout_url:null,payable:row.payable};
}
