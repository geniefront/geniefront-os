import './membershipAccess';
import {membershipCurrentContract,membershipInvoiceContract} from '../commerce/membershipContracts';
import {createHash,randomBytes} from 'node:crypto';
import {jsonb} from '@gf/db';
import {AppError,ERROR_CODES,pickText,CommerceSaveMembershipPlan,CommerceEnrollMembership,CommerceBindMembershipCustomer,
 CommerceRecordMembershipState,CommerceRecordMembershipInvoice,CommerceGrantMembershipCycles,CommerceAuthorizeMembershipPortal,membershipText,type CustomerMembershipTerms} from '@gf/contracts';
import {commerceFingerprint} from '@gf/payroll';
import {membershipBenefitPeriods} from '@gf/scheduling';
import {registerHandler,type HandlerArgs} from '../bus';
import {assertCommerceEnabled,commerceLiveMode} from '../commerce/config';
import {queueTask} from './commerce';
import {wrapManageToken,hashManageToken,unwrapManageToken} from '../public/bookingToken';
import {escapeHtml} from '../email/layout';
import {commerceReturnBase} from '../commerce/provider';
import {expireMembershipCycles} from './membershipUnits';
import {stopMembershipCycles} from './membershipTermination';
import type {Tx,Ctx,PurchaseSnapshot} from '../commerce/model';
export interface MembershipSnapshot {version:1;terms:CustomerMembershipTerms;currency:string;timezone:string;policyVersion:'customer-membership-v1';}
export interface PaidMembershipRow {id:string;customer_id:string;account_id:string;original_order_id:string;plan_version_id:string;
 snapshot:MembershipSnapshot;stripe_customer_id:string|null;stripe_subscription_id:string|null;stripe_price_id:string|null;
 livemode:boolean;provider_status:string;provider_observed_at:Date|null;terminated_at:Date|null;commerce_frozen:boolean;cancel_at_period_end:boolean;current_period_end:string|null;
 scheduled_cancel_at:string|null;provider_cancel_at_period_end:boolean|null;termination_id:string|null;}
function invalid(reason:string):never {throw new AppError(ERROR_CODES.VALIDATION_FAILED,{details:{reason}});}
async function member(tx:Tx,id:string):Promise<PaidMembershipRow>{
 const [m]=await tx<PaidMembershipRow[]>`select * from customer_paid_memberships where id=${id} for update`;
 if(!m)throw new AppError(ERROR_CODES.NOT_FOUND);return m;
}
registerHandler(CommerceSaveMembershipPlan,async({tx,ctx,input,audit})=>{
 assertCommerceEnabled();
 const ids=[...new Set([...input.terms.serviceIds,...input.terms.discountServiceIds])];
 const services=ids.length?await tx<{id:string}[]>`select id from services where id=any(${ids}::uuid[]) and location_id=${ctx.locationId} and active`:[];
 if(services.length!==ids.length)invalid('membership_services_unavailable');
 let planId=input.planId,version=1;
 if(planId){
  const [plan]=await tx`select id from customer_membership_plans where id=${planId} for update`;
  if(!plan)throw new AppError(ERROR_CODES.NOT_FOUND);
  const [last]=await tx<{version:number}[]>`select version from customer_membership_plan_versions where plan_id=${planId} order by version desc limit 1`;
  if(!last||input.expectedVersion!==last.version)invalid('membership_plan_changed');version=last.version+1;
  await tx`update customer_membership_plans set active=${input.active},online_sale=${input.onlineSale} where id=${planId}`;
 }else{
  if(input.expectedVersion!==undefined)invalid('membership_plan_changed');
  const [p]=await tx<{id:string}[]>`insert into customer_membership_plans(org_id,location_id,active,online_sale)
   values(${ctx.orgId},${ctx.locationId},${input.active},${input.onlineSale}) returning id`;planId=p!.id;
 }
 const [location]=await tx<{currency:string}[]>`select currency from locations where id=${ctx.locationId}`;
 const [v]=await tx<{id:string}[]>`insert into customer_membership_plan_versions(org_id,location_id,plan_id,version,terms,currency,created_by)
  values(${ctx.orgId},${ctx.locationId},${planId},${version},${jsonb(input.terms)}::jsonb,${location!.currency.toLowerCase()},${ctx.membershipId!}) returning id`;
 audit({entityType:'customer_membership_plan',entityId:planId,after:{version}});return {planId,versionId:v!.id,version};
});
registerHandler(CommerceEnrollMembership,async({tx,ctx,input,audit})=>{
 assertCommerceEnabled();
 const hash=createHash('sha256').update(commerceFingerprint(input)).digest('hex');
 await tx`select pg_advisory_xact_lock(hashtext(${ctx.locationId}),hashtext(${`purchase:${input.businessKey}`}))`;
 const [existing]=await tx<{id:string;request_hash:string;member_id:string|null}[]>`select o.id,o.request_hash,m.id as member_id from commerce_orders o
  left join customer_paid_memberships m on m.original_order_id=o.id where o.idem_key=${input.businessKey} and o.location_id=${ctx.locationId}`;
 if(existing){if(existing.request_hash!==hash||!existing.member_id)invalid('purchase_key_reused');
  audit({entityType:'customer_paid_membership',entityId:existing.member_id,after:{replayed:true}});return {membershipId:existing.member_id,orderId:existing.id};}
 const [location]=await tx<{currency:string;timezone:string;settings:{commerce?:{salesEnabled?:boolean;membershipsEnabled?:boolean}}}[]>`
  select currency,timezone,settings from locations where id=${ctx.locationId}`;
 if(!location?.settings.commerce?.membershipsEnabled)invalid('new_memberships_disabled');
 const [v]=await tx<{id:string;terms:CustomerMembershipTerms;currency:string}[]>`select v.id,v.terms,v.currency from customer_membership_plan_versions v
  join customer_membership_plans p on p.id=v.plan_id where v.id=${input.versionId} and p.active and p.online_sale
   and not exists(select 1 from customer_membership_plan_versions later where later.plan_id=v.plan_id and later.version>v.version)`;
 if(!v)invalid('membership_plan_changed');
 if(v.currency!==location.currency.toLowerCase()||v.terms.amountCents!==input.consent.amountCents||v.terms.cadence!==input.consent.cadence)invalid('membership_quote_changed');
 const livemode=commerceLiveMode();
 const [account]=await tx<{id:string;stripe_account_id:string;charges_enabled:boolean;disconnected:boolean;capabilities:Record<string,string>}[]>`
  select * from commerce_accounts where location_id=${ctx.locationId} and livemode=${livemode}`;
 if(!account||account.disconnected||!account.charges_enabled||account.capabilities.card_payments!=='active')invalid('connected_account_not_ready');
 const token=`cm_${randomBytes(32).toString('base64url')}`,wrapped=wrapManageToken(token);
 if(!wrapped)throw new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE,{details:{reason:'membership_manage_key_required'}});
 // Submitted email/name never grants an existing customer's financial assets.
 const [customer]=await tx<{id:string}[]>`insert into customers(org_id,primary_location_id,display_name,email,locale,source)
  values(${ctx.orgId},${ctx.locationId},${input.customer.name},${input.customer.email},${ctx.locale},'commerce') returning id`;
 const snapshot:MembershipSnapshot={version:1,terms:v.terms,currency:v.currency,timezone:location.timezone,policyVersion:'customer-membership-v1'};
 const acceptedAt=new Date().toISOString();
 const purchase:PurchaseSnapshot={version:1,kind:'customer_membership',name:pickText(v.terms.name,ctx.locale),templateId:v.id,
  amountCents:v.terms.amountCents,currency:v.currency,faceValueCents:0,sessions:v.terms.quantity,serviceIds:v.terms.serviceIds,
  scope:'location',validDays:null,coverageMode:'any_included',commissionBasis:v.terms.commissionBasis,
  recipientName:null,recipientNote:null,recipientEmail:null,consentVersion:'customer-membership-v1',consentAt:acceptedAt,membership:snapshot};
 const [o]=await tx<{id:string}[]>`insert into commerce_orders(org_id,location_id,customer_id,account_id,kind,channel,status,amount_cents,currency,snapshot,idem_key,request_hash)
  values(${ctx.orgId},${ctx.locationId},${customer!.id},${account.id},'customer_membership','online','pending',${v.terms.amountCents},${v.currency},${jsonb(purchase)}::jsonb,${input.businessKey},${hash}) returning id`;
 const [m]=await tx<{id:string}[]>`insert into customer_paid_memberships(org_id,location_id,customer_id,plan_version_id,account_id,original_order_id,snapshot,consent,livemode,
  manage_token_hash,manage_token_wrapped,manage_token_expires_at) values(${ctx.orgId},${ctx.locationId},${customer!.id},${v.id},${account.id},${o!.id},${jsonb(snapshot)}::jsonb,
  ${jsonb({...input.consent,policyVersion:'customer-membership-v1',acceptedAt})}::jsonb,${livemode},${hashManageToken(token)},${wrapped},now()+interval '30 days') returning id`;
 await tx`insert into commerce_payments(org_id,location_id,order_id,provider,method,status,amount_cents,currency,stripe_account_id,livemode)
  values(${ctx.orgId},${ctx.locationId},${o!.id},'stripe','membership_invoice','pending',${v.terms.amountCents},${v.currency},${account.stripe_account_id},${livemode})`;
 await queueTask(tx,ctx,'checkout',o!.id);await queueTask(tx,ctx,'reconcile',o!.id,30);
 audit({entityType:'customer_paid_membership',entityId:m!.id,after:{orderId:o!.id,status:'pending'}});return {membershipId:m!.id,orderId:o!.id};
});
async function accountMatches(tx:Tx,m:PaidMembershipRow,input:{stripeAccountId:string;livemode:boolean}):Promise<void>{
 const [a]=await tx<{stripe_account_id:string;livemode:boolean}[]>`select stripe_account_id,livemode from commerce_accounts where id=${m.account_id}`;
 if(a?.stripe_account_id!==input.stripeAccountId||a.livemode!==input.livemode||m.livemode!==input.livemode)invalid('membership_account_mismatch');
}
registerHandler(CommerceBindMembershipCustomer,async({tx,input,audit})=>{
 const m=await member(tx,input.membershipId);await accountMatches(tx,m,input);
 if(m.stripe_customer_id&&m.stripe_customer_id!==input.stripeCustomerId)invalid('membership_customer_mismatch');
 await tx`update customer_paid_memberships set stripe_customer_id=${input.stripeCustomerId},updated_at=now() where id=${m.id}`;
 audit({entityType:'customer_paid_membership',entityId:m.id,after:{customerBound:true}});return {bound:true};
});
registerHandler(CommerceAuthorizeMembershipPortal,async({tx,input,audit})=>{
 const [m]=await tx<{id:string;stripe_customer_id:string|null;stripe_subscription_id:string|null;commerce_frozen:boolean;disconnected:boolean}[]>`
  select m.id,m.stripe_customer_id,m.stripe_subscription_id,m.commerce_frozen,a.disconnected from customer_paid_memberships m
  join commerce_accounts a on a.id=m.account_id where m.id=${input.membershipId} and m.manage_token_hash=${input.tokenHash}
   and m.manage_token_expires_at>now() and m.manage_token_revoked_at is null for update of m`;
 if(!m)throw new AppError(ERROR_CODES.NOT_FOUND);
 if(m.disconnected||m.commerce_frozen||!m.stripe_customer_id||!m.stripe_subscription_id)invalid('membership_portal_unavailable');
 audit({entityType:'customer_paid_membership',entityId:m.id,after:{portalRequested:true}});return {authorized:true as const};
});
type StateInput=typeof CommerceRecordMembershipState.input._type;
export async function saveMembershipState(tx:Tx,m:PaidMembershipRow,input:StateInput):Promise<boolean>{
 await accountMatches(tx,m,input);
 if(m.stripe_customer_id!==input.stripeCustomerId||(m.stripe_subscription_id&&m.stripe_subscription_id!==input.subscriptionId)
 )invalid('membership_provider_binding_mismatch');
 const activeContract=await membershipCurrentContract(tx,m,input.priceId,input.currentPeriodStart);
 if((m.provider_observed_at&&new Date(input.observedAt)<new Date(m.provider_observed_at))
  ||(['canceled','incomplete_expired'].includes(m.provider_status)&&input.status!==m.provider_status))return false;
 await tx`update customer_paid_memberships set stripe_subscription_id=${input.subscriptionId},stripe_price_id=coalesce(stripe_price_id,${input.priceId}),current_price_id=${input.priceId},provider_status=${input.status},
  cancel_at_period_end=${input.cancelAtPeriodEnd},current_period_end=${input.currentPeriodEnd}::timestamptz,provider_observed_at=${input.observedAt}::timestamptz,
  scheduled_cancel_at=${input.cancelAt}::timestamptz,provider_cancel_at_period_end=${input.providerCancelAtPeriodEnd??input.cancelAtPeriodEnd},
  ended_at=case when ${['canceled','incomplete_expired'].includes(input.status)} then coalesce(ended_at,now()) else ended_at end,updated_at=now() where id=${m.id}`;
 if(activeContract.changeId)await tx`update customer_membership_plan_changes set status='applied',applied_at=coalesce(applied_at,now()),updated_at=now() where id=${activeContract.changeId} and status='scheduled'`;
 m={...m,snapshot:activeContract.snapshot};
 if(['canceled','incomplete_expired'].includes(input.status)){
  await tx`update customer_membership_plan_changes set status='canceled',canceled_at=coalesce(canceled_at,now()),updated_at=now() where membership_id=${m.id} and status in('pending','scheduled')`;
  if(input.status!==m.provider_status&&!m.termination_id)await membershipStateNotice(tx,m,input,'endedNotice');
 }else{
  if(input.cancelAtPeriodEnd!==m.cancel_at_period_end)await membershipStateNotice(tx,m,input,input.cancelAtPeriodEnd?'cancellationNotice':'renewalRestored');
  if(input.status!==m.provider_status&&['past_due','unpaid','incomplete'].includes(input.status))await membershipStateNotice(tx,m,input,'paymentFailedNotice');
 }
 return true;
}
async function membershipStateNotice(tx:Tx,m:PaidMembershipRow,input:StateInput,key:'cancellationNotice'|'renewalRestored'|'paymentFailedNotice'|'endedNotice'):Promise<void>{
 const [row]=await tx<{org_id:string;location_id:string;email:string|null;locale:string|null;slug:string;manage_token_hash:string;manage_token_wrapped:Buffer|null}[]>`
  select m.org_id,m.location_id,c.email,c.locale,l.slug,
   case when m.manage_token_revoked_at is null and m.manage_token_expires_at>now() then m.manage_token_hash else null end as manage_token_hash,
   case when m.manage_token_revoked_at is null and m.manage_token_expires_at>now() then m.manage_token_wrapped else null end as manage_token_wrapped
  from customer_paid_memberships m join customers c on c.id=m.customer_id join locations l on l.id=m.location_id where m.id=${m.id}`;
 if(!row?.email)return;
 const locale=row.locale??'en',token=row.manage_token_wrapped&&row.manage_token_hash?unwrapManageToken(row.manage_token_wrapped,row.manage_token_hash):null;
 let url:string|null=null;if(token&&process.env.BOOKING_BASE_URL){try{url=`${commerceReturnBase()}/${encodeURIComponent(row.slug)}/memberships?member=${m.id}#m/${token}`;}catch{}}
 const parts=[membershipText(locale,key),pickText(m.snapshot.terms.name,locale),
  `${new Intl.NumberFormat(locale,{style:'currency',currency:m.snapshot.currency}).format(m.snapshot.terms.amountCents/100)} / ${membershipText(locale,m.snapshot.terms.cadence)}`,
  ...(!['canceled','incomplete_expired'].includes(input.status)?[`${membershipText(locale,input.cancelAtPeriodEnd?'expires':'nextCharge')}: ${new Intl.DateTimeFormat(locale,{timeZone:m.snapshot.timezone,dateStyle:'medium',timeStyle:'short'}).format(new Date(input.currentPeriodEnd))}`]:[]),
  ...(url?[url]:[])];
 await tx`insert into email_outbox(org_id,location_id,kind,to_email,subject,body_html,body_text,entity_type,entity_id,commerce_order_id)
  values(${row.org_id},${row.location_id},'platform_notice',${row.email},${membershipText(locale,'title')},
   ${`<p>${parts.map(escapeHtml).join('</p><p>')}</p>`},${parts.join('\n')},${`customer_membership_${key}`},gen_random_uuid(),${m.original_order_id})`;
}
async function recordEvent(tx:Tx,ctx:Ctx,input:StateInput,objectId:string):Promise<void>{
 await tx`insert into commerce_events(org_id,location_id,stripe_account_id,livemode,event_id,event_type,object_id)
  values(${ctx.orgId},${ctx.locationId},${input.stripeAccountId},${input.livemode},${input.eventId},${input.eventType},${objectId}) on conflict do nothing`;
}
registerHandler(CommerceRecordMembershipState,async({tx,ctx,input,audit})=>{
 const m=await member(tx,input.membershipId),recorded=await saveMembershipState(tx,m,input);await recordEvent(tx,ctx,input,input.subscriptionId);
 audit({entityType:'customer_paid_membership',entityId:m.id,after:{status:input.status,recorded,cancelAtPeriodEnd:input.cancelAtPeriodEnd,
  scheduledCancelAt:input.cancelAt,providerCancelAtPeriodEnd:input.providerCancelAtPeriodEnd??input.cancelAtPeriodEnd}});return {recorded};
});
export async function grantMembershipCycles(tx:Tx,ctx:Ctx,m:PaidMembershipRow):Promise<{issued:number;nextRunAfterSec?:number}>{
 await stopMembershipCycles(tx,ctx,m);
 await expireMembershipCycles(tx,ctx,m);
 if(m.terminated_at||m.commerce_frozen)return {issued:0,...(m.commerce_frozen?{nextRunAfterSec:3600}:{})};
 const due=await tx<{id:string;quantity:number;value_cents:number}[]>`select id,quantity,value_cents from customer_membership_cycles
  where membership_id=${m.id} and status='planned' and starts_at<=now() and ends_at>now() order by starts_at,id for update`;
 for(const c of due){
  await tx`insert into customer_membership_ledger(org_id,location_id,cycle_id,entry,quantity,value_cents,unit_ranges,reference)
   values(${ctx.orgId},${ctx.locationId},${c.id},'issue',${c.quantity},${c.value_cents},int4multirange(int4range(0,${c.quantity},'[)')),'issue')`;
  await tx`update customer_membership_cycles set status='issued',issued_at=now(),available_units=int4multirange(int4range(0,${c.quantity},'[)')) where id=${c.id}`;
 }
 const [next]=await tx<{delay:number}[]>`select greatest(5,least(86400,ceil(extract(epoch from min(due)-now()))))::int as delay from
  (select case when status='planned' then starts_at else ends_at end as due from customer_membership_cycles
   where membership_id=${m.id} and status in('planned','issued')) future having count(*)>0`;
 return {issued:due.length,...(next?{nextRunAfterSec:next.delay}:{})};
}
registerHandler(CommerceGrantMembershipCycles,async({tx,ctx,input,audit})=>{
 const m=await member(tx,input.membershipId),result=await grantMembershipCycles(tx,ctx,m);
 audit({entityType:'customer_paid_membership',entityId:m.id,after:{cyclesIssued:result.issued}});return result;
});
async function paymentNotice(tx:Tx,ctx:Ctx,m:PaidMembershipRow,invoiceId:string,amount:number,periodEnd:string):Promise<void>{
 const [c]=await tx<{email:string|null;locale:string|null}[]>`select email,locale from customers where id=${m.customer_id}`;
 if(!c?.email)return;
 const locale=c.locale??ctx.locale,text=(key:Parameters<typeof membershipText>[1])=>membershipText(locale,key);
 const [access]=await tx<{manage_token_hash:string;manage_token_wrapped:Buffer;slug:string}[]>`select m.manage_token_hash,m.manage_token_wrapped,l.slug
  from customer_paid_memberships m join locations l on l.id=m.location_id where m.id=${m.id} and manage_token_revoked_at is null and manage_token_expires_at>now()`;
 const token=access?unwrapManageToken(access.manage_token_wrapped,access.manage_token_hash):null;
 let url:string|null=null;
 if(token&&process.env.BOOKING_BASE_URL){try{url=`${commerceReturnBase()}/${encodeURIComponent(access!.slug)}/memberships?member=${m.id}#m/${token}`;}catch{}}
 const parts=[text('paidBills'),pickText(m.snapshot.terms.name,locale),new Intl.NumberFormat(locale,{style:'currency',currency:m.snapshot.currency}).format(amount/100),
  ...(!m.termination_id&&!['canceled','incomplete_expired'].includes(m.provider_status)?[`${text(m.cancel_at_period_end?'expires':'nextCharge')}: ${new Intl.DateTimeFormat(locale,{timeZone:m.snapshot.timezone,dateStyle:'medium',timeStyle:'short'}).format(new Date(periodEnd))}`]:[]),text('noRollover'),...(url?[url]:[])];
 await tx`insert into email_outbox(org_id,location_id,kind,to_email,subject,body_html,body_text,entity_type,entity_id,commerce_order_id)
  values(${ctx.orgId},${ctx.locationId},'platform_notice',${c.email},${`${text('title')} · ${text('paidBills')}`},
   ${`<p>${parts.map(escapeHtml).join('</p><p>')}</p>`},${parts.join('\n')},'customer_membership_payment',${invoiceId},${m.original_order_id})
  on conflict(entity_type,entity_id,kind) do nothing`;
}
registerHandler(CommerceRecordMembershipInvoice,async({tx,ctx,input,audit})=>{
 const m=await member(tx,input.membershipId);await accountMatches(tx,m,input);
 if(m.stripe_customer_id!==input.stripeCustomerId||(m.stripe_subscription_id&&m.stripe_subscription_id!==input.subscriptionId)
 )invalid('membership_provider_binding_mismatch');
 const invoicePrice=input.invoicePriceId??input.priceId;
 const [prior]=await tx<{id:string;membership_id:string;order_id:string;period_start:Date;period_end:Date;stripe_price_id:string;amount_cents:number;currency:string}[]>`select i.*,p.amount_cents,p.currency from customer_membership_invoices i join commerce_payments p on p.id=i.payment_id
  where i.account_id=${m.account_id} and i.livemode=${input.livemode} and i.stripe_invoice_id=${input.invoiceId}`;
 if(prior){
  if(prior.membership_id!==m.id||prior.stripe_price_id!==invoicePrice||prior.amount_cents!==input.amountCents||prior.currency!==input.currency||new Date(prior.period_start).toISOString()!==input.periodStart||new Date(prior.period_end).toISOString()!==input.periodEnd)invalid('membership_invoice_changed');
  await recordEvent(tx,ctx,input,input.invoiceId);audit({entityType:'customer_paid_membership',entityId:m.id,after:{duplicateInvoice:true}});
  return {invoiceId:prior.id,orderId:prior.order_id,duplicate:true};
 }
 const contract=await membershipInvoiceContract(tx,m,invoicePrice,input.periodStart),s=contract.snapshot;if(input.amountCents!==s.terms.amountCents||input.currency!==s.currency)invalid('membership_invoice_amount_mismatch');
 const periods=membershipBenefitPeriods({...input,startsAt:input.periodStart,endsAt:input.periodEnd,cadence:s.terms.cadence,
  benefitFrequency:s.terms.benefitFrequency,timezone:s.timezone});
 const overlaps=await tx`select id from customer_membership_invoices where membership_id=${m.id}
  and period_start<${input.periodEnd}::timestamptz and period_end>${input.periodStart}::timestamptz`;
 if(overlaps.length)invalid('membership_invoice_period_overlap');
 await saveMembershipState(tx,m,input);
 const [original]=await tx<{status:string;snapshot:PurchaseSnapshot}[]>`select status,snapshot from commerce_orders where id=${m.original_order_id} for update`;
 const [firstInvoice]=await tx`select id from customer_membership_invoices where membership_id=${m.id} limit 1`;
 let orderId=m.original_order_id;
 if(firstInvoice){
  const [o]=await tx<{id:string}[]>`insert into commerce_orders(org_id,location_id,customer_id,account_id,kind,channel,status,amount_cents,currency,snapshot,asset_id,idem_key,request_hash)
   values(${ctx.orgId},${ctx.locationId},${m.customer_id},${m.account_id},'customer_membership','online','fulfilled',${input.amountCents},${input.currency},
    ${jsonb({...original!.snapshot,invoiceId:input.invoiceId,membership:s,name:pickText(s.terms.name,ctx.locale),templateId:contract.versionId,amountCents:s.terms.amountCents,sessions:s.terms.quantity,serviceIds:s.terms.serviceIds,commissionBasis:s.terms.commissionBasis})}::jsonb,${m.id},${`membership-invoice:${input.invoiceId}`},${commerceFingerprint({invoiceId:input.invoiceId})}) returning id`;
  orderId=o!.id;
  await tx`insert into commerce_payments(org_id,location_id,order_id,provider,method,status,amount_cents,currency,stripe_account_id,livemode,payment_intent_id,paid_at)
   values(${ctx.orgId},${ctx.locationId},${orderId},'stripe','membership_invoice','paid',${input.amountCents},${input.currency},${input.stripeAccountId},${input.livemode},${input.paymentIntentId},${input.paidAt}::timestamptz)`;
 }else{
  await tx`update commerce_payments set status='paid',payment_intent_id=${input.paymentIntentId},paid_at=${input.paidAt}::timestamptz
   where order_id=${orderId} and provider='stripe' and status='pending'`;
  await tx`update commerce_orders set status='fulfilled',asset_id=${m.id},updated_at=now() where id=${orderId}`;
 }
 const [p]=await tx<{id:string}[]>`select id from commerce_payments where order_id=${orderId} and payment_intent_id=${input.paymentIntentId} and status='paid'`;
 if(!p)invalid('membership_payment_missing');
 const [invoice]=await tx<{id:string}[]>`insert into customer_membership_invoices(org_id,location_id,membership_id,account_id,livemode,stripe_invoice_id,order_id,payment_id,period_start,period_end,paid_at,plan_version_id,snapshot,stripe_price_id)
  values(${ctx.orgId},${ctx.locationId},${m.id},${m.account_id},${input.livemode},${input.invoiceId},${orderId},${p.id},${input.periodStart}::timestamptz,${input.periodEnd}::timestamptz,${input.paidAt}::timestamptz,${contract.versionId},${jsonb(s)}::jsonb,${invoicePrice}) returning id`;
 for(const cycle of periods)await tx`insert into customer_membership_cycles(org_id,location_id,membership_id,invoice_id,cycle_index,starts_at,ends_at,quantity,value_cents)
  values(${ctx.orgId},${ctx.locationId},${m.id},${invoice!.id},${cycle.index},${cycle.startsAt}::timestamptz,${cycle.endsAt}::timestamptz,${s.terms.quantity},${cycle.valueCents})`;
 await grantMembershipCycles(tx,ctx,m);
 await tx`insert into commerce_tasks(org_id,location_id,kind,subject_id,retry_at) values(${ctx.orgId},${ctx.locationId},'membership_grant',${m.id},now()+interval '1 minute')
  on conflict(kind,subject_id) do update set status=case when commerce_tasks.status='processing' then 'processing' else 'pending' end,retry_at=least(commerce_tasks.retry_at,excluded.retry_at)`;
 await queueTask(tx,ctx,'reconcile',orderId,30);await recordEvent(tx,ctx,input,input.invoiceId);
 await paymentNotice(tx,ctx,{...m,snapshot:s},invoice!.id,input.amountCents,input.currentPeriodEnd);
 audit({entityType:'customer_paid_membership',entityId:m.id,after:{invoiceId:invoice!.id,orderId,plannedCycles:periods.length}});
 return {invoiceId:invoice!.id,orderId,duplicate:false};
});
