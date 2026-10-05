import type Stripe from 'stripe';
import { AppError,ERROR_CODES } from '@gf/contracts';
import { withTenant } from '@gf/db';
import {commerceStripeClient as stripeClient} from './client';
import { commerceLiveMode } from './config';
import type { Ctx,OrderRow,PaymentRow } from './model';
import {unwrapManageToken} from '../public/bookingToken';
import {hostedManageBookingUrl} from '../links';

function assertSessionContext(session:Stripe.Checkout.Session,ctx:Ctx,order:OrderRow,payment:PaymentRow):void{
  if(session.livemode!==payment.livemode||session.client_reference_id!==order.id||session.metadata?.gf_domain!=='customer_commerce'
    ||session.metadata.gf_order_id!==order.id||session.metadata.gf_location_id!==ctx.locationId||session.metadata.gf_org_id!==ctx.orgId
    ||session.amount_total!==order.amount_cents||session.currency!==order.currency)
    throw new AppError(ERROR_CODES.VALIDATION_FAILED,{details:{reason:'checkout_context_mismatch'}});
}
async function findOriginalSession(ctx:Ctx,order:OrderRow&{created_at:string},payment:PaymentRow):Promise<Stripe.Checkout.Session|null>{
  for await(const session of stripeClient().checkout.sessions.list({limit:100,created:{gte:Math.floor(Date.parse(order.created_at)/1000)}},
    {stripeAccount:payment.stripe_account_id!})){
    if(session.metadata?.gf_order_id!==order.id)continue;
    assertSessionContext(session,ctx,order,payment);return session;
  }
  return null;
}

export function commerceReturnBase():string {
  const raw=process.env.BOOKING_BASE_URL;
  if(!raw)throw new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE,{details:{reason:'BOOKING_BASE_URL_required'}});
  const url=new URL(raw);
  if(url.username||url.password||url.search||url.hash||(url.protocol!=='https:'&&!['localhost','127.0.0.1'].includes(url.hostname)))
    throw new AppError(ERROR_CODES.VALIDATION_FAILED,{details:{reason:'unsafe_commerce_return_url'}});
  return url.origin;
}
export const metadataOf = (ctx:Ctx,orderId:string) => ({gf_domain:'customer_commerce',gf_org_id:ctx.orgId,gf_location_id:ctx.locationId,gf_order_id:orderId});
export async function createCommerceCheckout(ctx:Ctx,orderId:string):Promise<Stripe.Checkout.Session> {
  const [kind]=await withTenant(ctx,tx=>tx<{kind:string}[]>`select kind from commerce_orders where id=${orderId}`);
  if(kind?.kind==='customer_membership')return (await import('./customerMembership')).createMembershipCheckout(ctx,orderId);
  const data=await withTenant(ctx,async tx=>{
    const [order]=await tx<(OrderRow&{created_at:string})[]>`select *,created_at::text from commerce_orders where id=${orderId} and location_id=${ctx.locationId}`;
    const [payment]=await tx<PaymentRow[]>`select * from commerce_payments where order_id=${orderId}`;
    const [location]=await tx<{slug:string|null}[]>`select slug from locations where id=${ctx.locationId}`;
    const [deposit]=order?.kind==='deposit'?await tx<{payable:boolean;wrapped:Buffer|null;digest:string|null}[]>`
      select r.state='open' and r.expires_at>now() and h.waived_at is null and not h.commerce_frozen
       and a.status in('booked','checked_in','in_service') and not exists(select 1 from tickets t where t.appointment_id=a.id and t.status<>'voided' and t.service_settled_at is not null) as payable,
       a.manage_token_wrapped as wrapped,a.manage_token_digest as digest
      from commerce_deposit_requests r join commerce_appointment_holds h on h.id=r.hold_id join appointments a on a.id=h.appointment_id where r.order_id=${orderId}`:[];
    return {order,payment,location,deposit};
  });
  const {order,payment,location,deposit}=data;
  if(!order||!payment||payment.provider!=='stripe'||!payment.stripe_account_id||payment.livemode!==commerceLiveMode()||!location?.slug)
    throw new AppError(ERROR_CODES.VALIDATION_FAILED,{details:{reason:'checkout_context_mismatch'}});
  const stripe=stripeClient();
  const options={stripeAccount:payment.stripe_account_id,idempotencyKey:`gf-commerce-checkout:${order.id}`};
  if(payment.checkout_session_id)return stripe.checkout.sessions.retrieve(payment.checkout_session_id,{}, {stripeAccount:payment.stripe_account_id});
  if(order.kind==='deposit'&&!deposit?.payable){
    const original=await findOriginalSession(ctx,order,payment);if(original)return original;
    throw new AppError(ERROR_CODES.VALIDATION_FAILED,{details:{reason:'deposit_hold_expired'}});
  }
  let returnUrl=`${commerceReturnBase()}/${encodeURIComponent(location.slug)}/shop`;
  if(order.kind==='deposit'){
    const token=deposit?.wrapped&&deposit.digest?unwrapManageToken(deposit.wrapped,deposit.digest):null;
    const guestUrl=token?hostedManageBookingUrl({shopSlug:location.slug,manageToken:token},{...process.env,BOOKING_PAGE_ORIGIN:commerceReturnBase()}):null;
    if(!guestUrl)throw new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE,{details:{reason:'deposit_manage_link_unavailable'}});
    returnUrl=guestUrl;
  }
  const metadata=metadataOf(ctx,order.id);
  return stripe.checkout.sessions.create({
    mode:'payment',payment_method_types:['card'],client_reference_id:order.id,
    line_items:[{price_data:{currency:order.currency,unit_amount:order.amount_cents,product_data:{name:order.snapshot.name}},quantity:1}],
    metadata,payment_intent_data:{metadata},
    success_url:order.kind==='deposit'?returnUrl:`${returnUrl}?order=${order.id}&checkout=returned`,
    cancel_url:order.kind==='deposit'?returnUrl:`${returnUrl}?order=${order.id}&checkout=canceled`,
    // Provider default (24h) is distinct from the 15m local hold. Omitting expires_at
    // also keeps retry parameters identical after external success + database failure.
  },options);
}
/** Expire only the server-mapped original Session, including recovery after external creation + DB failure. */
export async function expireCommerceCheckout(ctx:Ctx,orderId:string):Promise<{session:Stripe.Checkout.Session|null;nextRunAfterSec?:number}>{
  const data=await withTenant(ctx,async tx=>{
    const [order]=await tx<(OrderRow&{created_at:string})[]>`select *,created_at::text from commerce_orders where id=${orderId}`;
    const [payment]=await tx<PaymentRow[]>`select * from commerce_payments where order_id=${orderId}`;
    const [task]=await tx<{status:string}[]>`select status from commerce_tasks where subject_id=${orderId} and kind='checkout'`;
    return {order,payment,task};
  });
  const {order,payment,task}=data;
  if(!order||order.kind!=='deposit'||payment?.provider!=='stripe'||!payment.stripe_account_id||payment.livemode!==commerceLiveMode())
    throw new AppError(ERROR_CODES.VALIDATION_FAILED,{details:{reason:'checkout_context_mismatch'}});
  const options={stripeAccount:payment.stripe_account_id};
  const session=payment.checkout_session_id?await stripeClient().checkout.sessions.retrieve(payment.checkout_session_id,{},options)
    :await findOriginalSession(ctx,order,payment);
  if(!session)return task&&['pending','processing'].includes(task.status)?{session:null,nextRunAfterSec:15}:{session:null};
  assertSessionContext(session,ctx,order,payment);
  if(session.status!=='open')return {session};
  try{return {session:await stripeClient().checkout.sessions.expire(session.id,{}, {...options,idempotencyKey:`gf-commerce-expire:${order.id}`})};}
  catch(error){
    // Payment can win the race against expiration. Observe the authoritative final state before failing/retrying.
    const current=await stripeClient().checkout.sessions.retrieve(session.id,{},options);
    assertSessionContext(current,ctx,order,payment);
    if(current.status!=='open')return {session:current};throw error;
  }
}
export async function submitCommerceRefund(ctx:Ctx,refundId:string):Promise<Stripe.Refund> {
  const [data]=await withTenant(ctx,tx=>tx<{amount_cents:number;payment_intent_id:string;stripe_account_id:string;livemode:boolean;order_id:string;currency:string;membership_refund_request_id:string|null}[]>`
    select r.amount_cents,p.payment_intent_id,p.stripe_account_id,p.livemode,p.order_id,p.currency,r.membership_refund_request_id from commerce_refunds r
    join commerce_payments p on p.id=r.payment_id where r.id=${refundId} and r.status='pending' and p.provider='stripe'`);
  if(!data||!data.payment_intent_id||!data.stripe_account_id||data.livemode!==commerceLiveMode())
    throw new AppError(ERROR_CODES.VALIDATION_FAILED,{details:{reason:'refund_context_mismatch'}});
  const [blocked]=await withTenant(ctx,tx=>tx`select r.id from commerce_refunds r join customer_membership_refund_requests q on q.id=r.membership_refund_request_id
    join customer_membership_terminations t on t.id=q.termination_id where r.id=${refundId} and t.status='pending'`);
  if(blocked)throw new AppError(ERROR_CODES.VALIDATION_FAILED,{details:{reason:'membership_cancellation_not_confirmed'}});
  const result=await stripeClient().refunds.create({payment_intent:data.payment_intent_id,amount:data.amount_cents,
    metadata:{...metadataOf(ctx,data.order_id),gf_refund_id:refundId}},
    {stripeAccount:data.stripe_account_id,idempotencyKey:`gf-commerce-refund:${refundId}`});
  if(data.membership_refund_request_id&&(result.amount!==data.amount_cents||result.currency!==data.currency||
    (typeof result.payment_intent==='string'?result.payment_intent:result.payment_intent?.id)!==data.payment_intent_id||result.metadata?.gf_refund_id!==refundId))
    throw new AppError(ERROR_CODES.VALIDATION_FAILED,{details:{reason:'refund_provider_context_mismatch'}});
  return result;
}
