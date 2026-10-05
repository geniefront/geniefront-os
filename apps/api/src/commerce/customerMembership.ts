import {withMembershipProviderLock} from './membershipLocks';
import {membershipCurrentContract,membershipInvoiceContract} from './membershipContracts';
import type Stripe from 'stripe';
import {z} from 'zod';
import {withTenant} from '@gf/db';
import {AppError,ERROR_CODES} from '@gf/contracts';
import {dispatch} from '../bus';
import {commerceStripeClient} from './client';
import {commerceLiveMode} from './config';
import {commerceReturnBase,metadataOf} from './provider';
import {workerContext} from './worker';
import {unwrapManageToken} from '../public/bookingToken';
import type {Ctx} from './model';
import type {PaidMembershipRow} from '../handlers/customerMembership';
export const membershipMetadata=z.object({gf_domain:z.literal('customer_commerce'),gf_org_id:z.string().uuid(),gf_location_id:z.string().uuid(),
 gf_order_id:z.string().uuid(),gf_membership_id:z.string().uuid()});
const idOf=(value:unknown):string|null=>typeof value==='string'?value:value&&typeof value==='object'&&'id' in value?String(value.id):null;
function invalid(reason:string):never {throw new AppError(ERROR_CODES.VALIDATION_FAILED,{details:{reason}});}
export async function membershipManageUrl(ctx:Ctx,membershipId:string):Promise<string>{
 const [row]=await withTenant(ctx,tx=>tx<{manage_token_wrapped:Buffer;manage_token_hash:string;manage_token_expires_at:Date;manage_token_revoked_at:Date|null;slug:string}[]>`
  select m.manage_token_wrapped,m.manage_token_hash,m.manage_token_expires_at,m.manage_token_revoked_at,l.slug from customer_paid_memberships m
  join locations l on l.id=m.location_id where m.id=${membershipId}`);
 const token=row&&!row.manage_token_revoked_at&&new Date(row.manage_token_expires_at)>new Date()?unwrapManageToken(row.manage_token_wrapped,row.manage_token_hash):null;
 if(!token)throw new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE,{details:{reason:'membership_manage_link_unavailable'}});
 return `${commerceReturnBase()}/${encodeURIComponent(row!.slug)}/memberships?member=${membershipId}#m/${token}`;
}
export async function createMembershipCheckout(ctx:Ctx,orderId:string):Promise<Stripe.Checkout.Session>{
 const [m]=await withTenant(ctx,tx=>tx<(PaidMembershipRow&{stripe_account_id:string;created_at:Date;customer_name:string;email:string;checkout_session_id:string|null})[]>`
  select m.*,a.stripe_account_id,c.display_name as customer_name,c.email,p.checkout_session_id from customer_paid_memberships m
  join commerce_accounts a on a.id=m.account_id join customers c on c.id=m.customer_id join commerce_payments p on p.order_id=m.original_order_id
  where m.original_order_id=${orderId}`);
 if(!m||m.livemode!==commerceLiveMode())invalid('membership_checkout_context');
 const stripe=commerceStripeClient(),options={stripeAccount:m.stripe_account_id},metadata={...metadataOf(ctx,orderId),gf_membership_id:m.id};
 const check=(session:Stripe.Checkout.Session)=>{
  if(session.mode!=='subscription'||session.livemode!==m.livemode||session.client_reference_id!==orderId||session.metadata?.gf_membership_id!==m.id
    ||session.metadata.gf_order_id!==orderId||session.metadata.gf_org_id!==ctx.orgId||session.metadata.gf_location_id!==ctx.locationId)invalid('membership_checkout_context');
  return session;
 };
 if(m.checkout_session_id)return check(await stripe.checkout.sessions.retrieve(m.checkout_session_id,{},options));
 if(['canceled','incomplete_expired'].includes(m.provider_status))invalid('membership_already_ended');
 // Recover beyond Stripe's idempotency retention if external creation succeeded before a local crash.
 let customerId=m.stripe_customer_id;
 if(!customerId){
  for await(const c of stripe.customers.list({limit:100,created:{gte:Math.floor(new Date(m.created_at).getTime()/1000)}},options)){
   if(c.metadata.gf_membership_id===m.id&&c.metadata.gf_org_id===ctx.orgId&&c.metadata.gf_location_id===ctx.locationId){customerId=c.id;break;}
  }
  if(!customerId){const customer=await stripe.customers.create({name:m.customer_name,email:m.email,metadata},
   {...options,idempotencyKey:`gf-membership-customer:${m.id}`});customerId=customer.id;}
  await dispatch('commerce.bindMembershipCustomer',{membershipId:m.id,stripeAccountId:m.stripe_account_id,livemode:m.livemode,stripeCustomerId:customerId},ctx,
   {systemOrigin:'commerce_verified_membership_customer',idempotencyKey:`membership-customer:${m.id}:${customerId}`});
 }
 for await(const session of stripe.checkout.sessions.list({customer:customerId,limit:100},options)){
  if(session.metadata?.gf_membership_id===m.id)return check(session);
 }
 const returnUrl=await membershipManageUrl(ctx,m.id),terms=m.snapshot.terms;
 return check(await stripe.checkout.sessions.create({mode:'subscription',payment_method_types:['card'],customer:customerId,client_reference_id:orderId,
  line_items:[{quantity:1,price_data:{currency:m.snapshot.currency,unit_amount:terms.amountCents,recurring:{interval:terms.cadence,interval_count:1},
   product_data:{name:terms.name.en!}}}],metadata,subscription_data:{metadata},success_url:returnUrl,cancel_url:returnUrl,
 },{...options,idempotencyKey:`gf-membership-checkout:${m.id}`}));
}
export async function verifiedSubscription(subscriptionId:string,account:string,livemode:boolean){
 const observedAt=new Date().toISOString(),stripe=commerceStripeClient();
 const sub=await stripe.subscriptions.retrieve(subscriptionId,{}, {stripeAccount:account});
 const meta=membershipMetadata.safeParse(sub.metadata);if(!meta.success)return null;
 if(sub.livemode!==livemode||livemode!==commerceLiveMode())invalid('membership_mode_mismatch');
 const ctx=workerContext(meta.data.gf_org_id,meta.data.gf_location_id);
 const [m]=await withTenant(ctx,tx=>tx<(PaidMembershipRow&{stripe_account_id:string})[]>`select m.*,a.stripe_account_id from customer_paid_memberships m
  join commerce_accounts a on a.id=m.account_id where m.id=${meta.data.gf_membership_id} and m.original_order_id=${meta.data.gf_order_id}`);
 const item=sub.items.data[0],customerId=idOf(sub.customer);
 if(!m||m.stripe_account_id!==account||m.livemode!==livemode||m.stripe_customer_id!==customerId
  ||(m.stripe_subscription_id&&m.stripe_subscription_id!==sub.id))invalid('membership_provider_binding_mismatch');
 if(!item)invalid('membership_subscription_contract_mismatch');
 const contract=await withTenant(ctx,tx=>membershipCurrentContract(tx,m,item.price.id,new Date(item.current_period_start*1000).toISOString()));
 if(sub.items.has_more||sub.items.data.length!==1||item?.quantity!==1||item.price.unit_amount!==contract.snapshot.terms.amountCents
  ||item.price.currency!==contract.snapshot.currency||item.price.recurring?.interval!==contract.snapshot.terms.cadence||item.price.recurring.interval_count!==1
  ||sub.trial_end||sub.discounts.length||item.discounts.length)invalid('membership_subscription_contract_mismatch');
 return {ctx,m,sub,item,observedAt,customerId:customerId!};
}
export function membershipCancellationFact(sub:Pick<Stripe.Subscription,'cancel_at'|'cancel_at_period_end'>,periodEnd:number){
 const cancelAt=sub.cancel_at??null;
 return {cancelAtPeriodEnd:sub.cancel_at_period_end||cancelAt===periodEnd,cancelAt:cancelAt===null?null:new Date(cancelAt*1000).toISOString(),providerCancelAtPeriodEnd:sub.cancel_at_period_end};
}
export function stateFact(data:NonNullable<Awaited<ReturnType<typeof verifiedSubscription>>>,account:string,livemode:boolean,eventId:string,eventType:string){
 return {membershipId:data.m.id,stripeAccountId:account,livemode,stripeCustomerId:data.customerId,subscriptionId:data.sub.id,priceId:data.item.price.id,
  status:data.sub.status,...membershipCancellationFact(data.sub,data.item.current_period_end),currentPeriodEnd:new Date(data.item.current_period_end*1000).toISOString(),currentPeriodStart:new Date(data.item.current_period_start*1000).toISOString(),
  observedAt:data.observedAt,eventId,eventType};
}
/** The worker never infers cancellation from a local flag or a successful refund. */
export async function cancelMembershipForTermination(ctx:Ctx,terminationId:string){
 const [row]=await withTenant(ctx,tx=>tx`select membership_id from customer_membership_terminations where id=${terminationId}`);
 if(!row)invalid('membership_termination_context');
 return withMembershipProviderLock(ctx,row.membership_id,()=>cancelMembershipForTerminationLocked(ctx,terminationId));
}
async function cancelMembershipForTerminationLocked(ctx:Ctx,terminationId:string){
 const [t]=await withTenant(ctx,tx=>tx<{membership_id:string;status:string;stripe_subscription_id:string;stripe_account_id:string;livemode:boolean}[]>`
  select t.membership_id,t.status,m.stripe_subscription_id,a.stripe_account_id,m.livemode from customer_membership_terminations t
  join customer_paid_memberships m on m.id=t.membership_id join commerce_accounts a on a.id=m.account_id where t.id=${terminationId}`);
 if(!t||!t.stripe_subscription_id||t.livemode!==commerceLiveMode())invalid('membership_termination_context');
 if(t.status!=='pending')return;
 const verify=async()=>{const d=await verifiedSubscription(t.stripe_subscription_id,t.stripe_account_id,t.livemode);
  if(!d||d.m.id!==t.membership_id||d.ctx.orgId!==ctx.orgId||d.ctx.locationId!==ctx.locationId)invalid('membership_termination_context');return d;};
 let current=await verify();
 if(current.sub.status!=='canceled'){
  try{await commerceStripeClient().subscriptions.cancel(current.sub.id,{invoice_now:false,prorate:false},
   {stripeAccount:t.stripe_account_id,idempotencyKey:`gf-membership-terminate:${terminationId}`});}
  catch(error){current=await verify();if(current.sub.status!=='canceled')throw error;}
  current=await verify();
 }
 if(current.sub.status!=='canceled'||!current.sub.canceled_at)invalid('membership_cancellation_not_confirmed');
 await dispatch('commerce.completeMembershipTermination',{
  ...stateFact(current,t.stripe_account_id,t.livemode,`termination-retrieve:${terminationId}`, 'membership.termination.retrieve'),terminationId,
  providerCanceledAt:new Date(current.sub.canceled_at*1000).toISOString()},ctx,
  {systemOrigin:'commerce_verified_membership_termination',idempotencyKey:`membership-termination-verified:${terminationId}:${current.sub.canceled_at}`});
}
/** Only retrieved invoice payments and a succeeded intent establish cash; active status is never a grant. */
export async function recordVerifiedMembershipInvoice(invoiceId:string,account:string,livemode:boolean,eventId:string,eventType:string):Promise<string>{
 const stripe=commerceStripeClient(),options={stripeAccount:account};
 const invoice=await stripe.invoices.retrieve(invoiceId,{},options);
 const subId=idOf(invoice.parent?.subscription_details?.subscription);if(!subId)return 'ignored_other_domain';
 const data=await verifiedSubscription(subId,account,livemode);if(!data)return 'ignored_other_domain';
 const fact=stateFact(data,account,livemode,eventId,eventType);
 if(invoice.status!=='paid'){
  await dispatch('commerce.recordMembershipState',fact,data.ctx,{systemOrigin:'commerce_verified_membership_state',idempotencyKey:`membership-state:${account}:${eventId}:${data.observedAt}`});
  return 'membership_awaiting_payment';
 }
 const lines=invoice.lines.data,line=lines[0],invoicePrice=idOf(line?.pricing?.price_details?.price);
 if(!line||!invoicePrice)invalid('membership_invoice_contract_mismatch');
 const invoiceContract=await withTenant(data.ctx,tx=>membershipInvoiceContract(tx,data.m,invoicePrice,new Date(line.period.start*1000).toISOString()));
 if(invoice.livemode!==livemode||idOf(invoice.customer)!==data.customerId||invoice.lines.has_more||lines.length!==1
  ||!line||line.parent?.subscription_item_details?.proration
  ||invoice.amount_paid!==invoiceContract.snapshot.terms.amountCents||invoice.total!==invoice.amount_paid||invoice.amount_remaining!==0
  ||invoice.currency!==invoiceContract.snapshot.currency||!invoice.status_transitions.paid_at)invalid('membership_invoice_contract_mismatch');
 const payments=await stripe.invoicePayments.list({invoice:invoice.id,status:'paid',limit:100},options),payment=payments.data[0];
 const intentId=idOf(payment?.payment.payment_intent);
 if(payments.has_more||payments.data.length!==1||payment?.livemode!==livemode||idOf(payment.invoice)!==invoice.id||payment.amount_paid!==invoice.amount_paid||!intentId)invalid('membership_invoice_cash_unverified');
 const intent=await stripe.paymentIntents.retrieve(intentId,{expand:['latest_charge.balance_transaction']},options);
 if(intent.livemode!==livemode||intent.status!=='succeeded'||intent.amount_received!==invoice.amount_paid||intent.currency!==invoice.currency
   ||idOf(intent.customer)!==data.customerId)invalid('membership_invoice_cash_unverified');
 await dispatch('commerce.recordMembershipInvoice',{...fact,invoiceId:invoice.id,invoicePriceId:invoicePrice,paymentIntentId:intentId,amountCents:invoice.amount_paid,currency:invoice.currency,
  periodStart:new Date(line.period.start*1000).toISOString(),periodEnd:new Date(line.period.end*1000).toISOString(),paidAt:new Date(invoice.status_transitions.paid_at*1000).toISOString()},
  data.ctx,{systemOrigin:'commerce_verified_membership_invoice',idempotencyKey:`membership-invoice-event:${account}:${eventId}:${data.observedAt}`});
 const charge=intent.latest_charge?typeof intent.latest_charge==='string'?await stripe.charges.retrieve(intent.latest_charge,{expand:['balance_transaction']},options):intent.latest_charge:null;
 if(charge){
  if(charge.livemode!==livemode||idOf(charge.payment_intent)!==intentId||charge.amount!==invoice.amount_paid)invalid('membership_charge_context_mismatch');
  const balance=charge.balance_transaction?typeof charge.balance_transaction==='string'?await stripe.balanceTransactions.retrieve(charge.balance_transaction,{},options):charge.balance_transaction:null;
  if(balance){
   const [paymentRow]=await withTenant(data.ctx,tx=>tx<{id:string}[]>`select id from commerce_payments where payment_intent_id=${intentId} and stripe_account_id=${account} and livemode=${livemode}`);
   if(paymentRow)await (await import('./reconciliation')).recordSettlement(data.ctx,{stripe_account_id:account,livemode},'payment',paymentRow.id,charge.id,charge.amount,balance,charge.created);
  }
 }
 return 'membership_invoice_recorded';
}
export async function processMembershipEvent(event:Stripe.Event):Promise<string>{
 const account=event.account!;
 if(event.type.startsWith('invoice.'))return recordVerifiedMembershipInvoice((event.data.object as {id:string}).id,account,event.livemode,event.id,event.type);
 if(event.type.startsWith('customer.subscription.')){
  const data=await verifiedSubscription((event.data.object as {id:string}).id,account,event.livemode);if(!data)return 'ignored_other_domain';
  await dispatch('commerce.recordMembershipState',stateFact(data,account,event.livemode,event.id,event.type),data.ctx,
   {systemOrigin:'commerce_verified_membership_state',idempotencyKey:`membership-state:${account}:${event.id}:${data.observedAt}`});return 'membership_state_recorded';
 }
 const session=event.data.object as Stripe.Checkout.Session;
 if(session.mode!=='subscription'||!session.metadata?.gf_membership_id)return 'ignored_other_domain';
 const current=await commerceStripeClient().checkout.sessions.retrieve(session.id,{}, {stripeAccount:account}),subId=idOf(current.subscription);
 if(current.livemode!==event.livemode)invalid('membership_mode_mismatch');
 if(!subId)return 'membership_awaiting_payment';
 const data=await verifiedSubscription(subId,account,event.livemode);if(!data)return 'ignored_other_domain';
 if(current.client_reference_id!==data.m.original_order_id||current.metadata?.gf_membership_id!==data.m.id||idOf(current.customer)!==data.customerId)invalid('membership_checkout_context');
 const latest=idOf(data.sub.latest_invoice);
 return latest?recordVerifiedMembershipInvoice(latest,account,event.livemode,event.id,event.type):'membership_awaiting_payment';
}
export async function reconcileMembership(ctx:Ctx,orderId:string):Promise<number|undefined>{
 const [m]=await withTenant(ctx,tx=>tx<(PaidMembershipRow&{stripe_account_id:string;checkout_session_id:string|null})[]>`select m.*,a.stripe_account_id,p.checkout_session_id
  from customer_paid_memberships m join commerce_accounts a on a.id=m.account_id join commerce_payments p on p.order_id=m.original_order_id
  where m.original_order_id=${orderId} or m.id=(select membership_id from customer_membership_invoices where order_id=${orderId})`);
 if(!m)invalid('membership_missing');
 const stripe=commerceStripeClient(),options={stripeAccount:m.stripe_account_id};
 let subId=m.stripe_subscription_id;
 if(!subId&&m.checkout_session_id){const session=await stripe.checkout.sessions.retrieve(m.checkout_session_id,{},options);subId=idOf(session.subscription);}
 if(!subId)return ['canceled','incomplete_expired'].includes(m.provider_status)?undefined:60;
 const data=await verifiedSubscription(subId,m.stripe_account_id,m.livemode);if(!data)invalid('membership_provider_binding_mismatch');
 const observed=data.observedAt;
 await dispatch('commerce.recordMembershipState',stateFact(data,m.stripe_account_id,m.livemode,`reconcile:${m.id}:${observed}:state`,'membership.reconcile'),ctx,
  {systemOrigin:'commerce_membership_reconciliation',idempotencyKey:`membership-reconcile-state:${m.id}:${observed}`});
 let pendingRefund=false;
 for await(const invoice of stripe.invoices.list({subscription:subId,status:'paid',limit:100},options)){
  const [known]=await withTenant(ctx,tx=>tx<{id:string;balance_transaction_id:string|null}[]>`select p.id,p.balance_transaction_id from customer_membership_invoices i
   join commerce_payments p on p.id=i.payment_id where i.membership_id=${m.id} and i.stripe_invoice_id=${invoice.id}`);
  if(!known?.balance_transaction_id)await recordVerifiedMembershipInvoice(invoice.id,m.stripe_account_id,m.livemode,`reconcile:${invoice.id}:${observed}`,'membership.reconcile');
  if(known)pendingRefund=await (await import('./reconciliation')).reconcileMembershipPaymentRefunds(ctx,known.id)||pendingRefund;
 }
 return pendingRefund?60:['canceled','incomplete_expired'].includes(data.sub.status)?undefined:3600;
}
const portalRevision='customer-membership-portal-v1';
function portalConfigValid(c:Stripe.BillingPortal.Configuration,livemode:boolean,account:string):boolean{
 return c.active&&c.livemode===livemode&&c.metadata?.gf_domain==='customer_membership_portal'&&c.metadata?.gf_revision===portalRevision
  &&c.metadata.gf_stripe_account_id===account
  &&!c.features.customer_update.enabled&&!c.features.subscription_update.enabled&&c.features.invoice_history.enabled
  &&c.features.payment_method_update.enabled&&c.features.subscription_cancel.enabled&&c.features.subscription_cancel.mode==='at_period_end'
  &&c.features.subscription_cancel.proration_behavior==='none'&&!c.login_page.enabled;
}
/** Create a dedicated merchant configuration and pass its ID explicitly; never update existing/default SaaS configurations. */
async function membershipPortalConfiguration(livemode:boolean,account:string):Promise<Stripe.BillingPortal.Configuration>{
 const stripe=commerceStripeClient();
 const options={stripeAccount:account};
 for await(const c of stripe.billingPortal.configurations.list({active:true,limit:100},options)){
  if(c.metadata?.gf_domain!=='customer_membership_portal'||c.metadata?.gf_revision!==portalRevision)continue;
  if(!portalConfigValid(c,livemode,account))invalid('membership_portal_configuration_changed');return c;
 }
 const config=await stripe.billingPortal.configurations.create({name:'Customer paid memberships',metadata:{gf_domain:'customer_membership_portal',gf_revision:portalRevision,gf_stripe_account_id:account},
  features:{customer_update:{enabled:false},subscription_update:{enabled:false},invoice_history:{enabled:true},payment_method_update:{enabled:true},
   subscription_cancel:{enabled:true,mode:'at_period_end',proration_behavior:'none',cancellation_reason:{enabled:true,options:['too_expensive','unused','other']}}},
  login_page:{enabled:false}}, {...options,idempotencyKey:`gf-${portalRevision}:${account}:${livemode?'live':'test'}`});
 if(!portalConfigValid(config,livemode,account))invalid('membership_portal_configuration_changed');return config;
}
export async function createMembershipPortal(ctx:Ctx,membershipId:string,locale:string,key:string,tokenHash:string):Promise<string>{
 try{
  const [m]=await withTenant(ctx,tx=>tx<(PaidMembershipRow&{stripe_account_id:string;disconnected:boolean})[]>`select m.*,a.stripe_account_id,a.disconnected from customer_paid_memberships m
   join commerce_accounts a on a.id=m.account_id where m.id=${membershipId} and m.manage_token_hash=${tokenHash}
    and m.manage_token_expires_at>now() and m.manage_token_revoked_at is null`);
  if(!m)throw new AppError(ERROR_CODES.NOT_FOUND);
  if(!m||m.disconnected||m.commerce_frozen||!m.stripe_subscription_id||!m.stripe_customer_id||m.livemode!==commerceLiveMode())invalid('membership_portal_unavailable');
  const data=await verifiedSubscription(m.stripe_subscription_id,m.stripe_account_id,m.livemode);
  if(!data||data.m.id!==m.id)invalid('membership_provider_binding_mismatch');
  const customer=await commerceStripeClient().customers.retrieve(m.stripe_customer_id,{}, {stripeAccount:m.stripe_account_id});
  if(customer.deleted||customer.metadata.gf_membership_id!==m.id||customer.metadata.gf_org_id!==ctx.orgId||customer.metadata.gf_location_id!==ctx.locationId)invalid('membership_customer_mismatch');
  // This resource bearer must not expose another subscription injected onto the same provider Customer.
  for await(const subscription of commerceStripeClient().subscriptions.list({customer:m.stripe_customer_id,status:'all',limit:100},{stripeAccount:m.stripe_account_id})){
   if(subscription.id!==m.stripe_subscription_id)invalid('membership_customer_has_other_subscriptions');
  }
  for await(const invoice of commerceStripeClient().invoices.list({customer:m.stripe_customer_id,limit:100},{stripeAccount:m.stripe_account_id})){
   if(idOf(invoice.parent?.subscription_details?.subscription)!==m.stripe_subscription_id)invalid('membership_customer_has_other_invoices');
  }
  const config=await membershipPortalConfiguration(m.livemode,m.stripe_account_id),returnUrl=await membershipManageUrl(ctx,m.id);
  const portalLocale:Stripe.BillingPortal.SessionCreateParams.Locale=locale==='zh-Hans'?'zh':locale==='zh-Hant'?'zh-TW':locale;
  const session=await commerceStripeClient().billingPortal.sessions.create({customer:m.stripe_customer_id,configuration:config.id,return_url:returnUrl,
   locale:['en','zh','zh-TW','es','ko','vi'].includes(portalLocale)?portalLocale:'en'},
   {stripeAccount:m.stripe_account_id,idempotencyKey:`gf-membership-portal:${m.id}:${key}`});
  if(session.customer!==m.stripe_customer_id||session.configuration!==config.id||session.livemode!==m.livemode
   ||new URL(session.url).origin!=='https://billing.stripe.com')invalid('membership_portal_context_mismatch');
  const [stillAuthorized]=await withTenant(ctx,tx=>tx`select id from customer_paid_memberships where id=${m.id} and manage_token_hash=${tokenHash}
   and manage_token_expires_at>now() and manage_token_revoked_at is null and not commerce_frozen`);
  if(!stillAuthorized)throw new AppError(ERROR_CODES.NOT_FOUND);
  return session.url;
 }catch(error){
  if(error instanceof AppError)throw error;
  const upstream=error as {code?:string;param?:string};
  throw new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE,{details:{reason:'membership_portal_provider_unavailable',
   providerCode:upstream.code?.slice(0,80)??'unavailable',providerField:upstream.param?.slice(0,80)??null}});
 }
}
