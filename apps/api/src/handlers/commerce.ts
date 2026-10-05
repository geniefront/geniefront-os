import { createHash,randomUUID } from 'node:crypto';
import { jsonb } from '@gf/db';
import { CommerceCreateOrder,CommercePublicOrder,CommerceSaveAccount,CommerceSaveSettings,CommerceDisconnectAccount,CommerceRecordPayment,
  CommerceRequestRefund,CommerceApproveGuestRefund,CommerceApplyExternalRefund,CommerceCompleteRefund,CommerceConfirmOfflineRefund,CommerceClaimTask,CommerceFinishTask,CommerceRetryTask,CommerceResendNotice,CommerceIssueAccess,CommerceRecordRisk,CommerceRecordSettlement,CommerceExpireOrder,
  AppError,ERROR_CODES,pickText,commerceText } from '@gf/contracts';
import { commerceFingerprint,giftPurchaseRefundLimit,giftFaceForRefund,refundPackageUnits,packageRangeCount,formatPackageUnitRanges,
  parsePackageUnitRanges,restorePackageUnits,allocateDepositRefundByGuest } from '@gf/payroll';
import { registerHandler,type HandlerArgs } from '../bus';
import {lockOpenDay} from './dayclose';
import { issueGiftCardInTransaction } from './giftcard';
import { assertCommerceEnabled,commerceLiveMode } from '../commerce/config';
import type { PurchaseSnapshot,OrderRow,PaymentRow,Tx,Ctx } from '../commerce/model';
import {queueCommerceNotice} from './commerceNotifications';
import {availablePackageUnits} from './packageUnits';
import {fulfillAppointmentDeposit,lockDepositOrder} from './appointmentDepositPayments';
import {depositPaymentSources} from '../commerce/depositSources';
import {refreshDepositFinancialState} from './appointmentDepositState';
import {lockMembershipOrder} from '../commerce/membershipLocks';
import {purchaseQuoteHash} from '../commerce/purchaseQuote';
import {syncMembershipTermination} from './membershipTermination';

function invalid(reason:string):never {throw new AppError(ERROR_CODES.VALIDATION_FAILED,{details:{reason}});}
function absent(entity:string):never {throw new AppError(ERROR_CODES.NOT_FOUND,{details:{entity}});}
const auditOrder = (audit:HandlerArgs<unknown>['audit'],id:string,status:string) => audit({entityType:'commerce_order',entityId:id,after:{status}});
async function paymentOf(tx:Tx,orderId:string) {const [p]=await tx<PaymentRow[]>`select * from commerce_payments where order_id=${orderId}`;return p;}
function resultOf(o:OrderRow,p?:PaymentRow) {return {orderId:o.id,status:o.status,paymentId:p?.id??null,assetId:o.asset_id};}

/** Fulfillment uses the immutable order, never a changed catalog template. Same command transaction as the payment. */
export async function fulfillOrderInTransaction(args:HandlerArgs<unknown>,order:OrderRow):Promise<void> {
  const {tx,ctx,audit}=args;
  if(order.asset_id)return;
  if(order.status!=='paid')invalid('payment_not_confirmed');
  const s=order.snapshot;
  let assetId:string;
  let finalStatus:'fulfilled'|'refund_pending'='fulfilled';
  if(order.kind==='deposit') {
    const deposited=await fulfillAppointmentDeposit(args,order);assetId=deposited.assetId;finalStatus=deposited.status;
  } else if(order.kind==='gift_card') {
    const issued=await issueGiftCardInTransaction({...args,input:{ faceValueCents:s.faceValueCents,salePriceCents:s.amountCents,
      scope:s.scope,purchaserCustomerId:order.customer_id,holderCustomerId:order.customer_id,
      source:order.channel==='online'?'online':'front_desk',
      ...(s.recipientName?{recipientName:s.recipientName}:{}),...(s.recipientNote?{recipientNote:s.recipientNote}:{}) }});
    assetId=issued.giftCardId;
    await tx`update gift_cards set template_id=${s.templateId},purchase_order_id=${order.id},purchase_snapshot=${jsonb(s)}::jsonb,
      expires_at=case when ${s.validDays}::int is null then null else now()+${s.validDays}::int*interval '1 day' end where id=${assetId}`;
  } else if(order.kind==='package') {
    if(!order.customer_id)invalid('package_requires_customer');
    const [pkg]=await tx<{id:string}[]>`insert into customer_packages
      (org_id,location_id,template_id,customer_id,remaining_sessions,total_sessions,status,expires_at,purchase_order_id,purchase_snapshot,available_units)
      values (${ctx.orgId},${ctx.locationId},${s.templateId},${order.customer_id},${s.sessions},${s.sessions},'active',
        case when ${s.validDays}::int is null then null else now()+${s.validDays}::int*interval '1 day' end,${order.id},${jsonb(s)}::jsonb,
        int4multirange(int4range(0,${s.sessions},'[)'))) returning id`;
    assetId=pkg!.id;
    await tx`insert into customer_package_ledger(org_id,location_id,package_id,entry,quantity,value_cents,reference,unit_ranges)
      values(${ctx.orgId},${ctx.locationId},${assetId},'issue',${s.sessions},${s.amountCents},${`purchase:${order.id}`},int4multirange(int4range(0,${s.sessions},'[)')))`;
    // Compatibility ledger remains explicitly cents for issue; quantities have their own ledger.
    await tx`insert into customer_credit_ledger(org_id,location_id,kind,subject_id,customer_id,entry,amount_cents,balance_after_cents,actor_membership_id,meta)
      values(${ctx.orgId},${ctx.locationId},'package',${assetId},${order.customer_id},'issue',${s.amountCents},${s.amountCents},${ctx.membershipId},
        ${jsonb({purchaseOrderId:order.id,unit:'cents'})}::jsonb)`;
    audit({entityType:'customer_package',entityId:assetId,after:{purchaseOrderId:order.id}});
  } else invalid('unsupported_purchase_type');
  await tx`update commerce_orders set asset_id=${assetId},status=${finalStatus},updated_at=now() where id=${order.id}`;
  order.asset_id=assetId;order.status=finalStatus;
  if(order.kind!=='deposit')await queueCommerceNotice(tx,ctx,order,'purchase');
}
const fulfill=fulfillOrderInTransaction;

export const createOrderInTransaction = async(args:HandlerArgs<typeof CommerceCreateOrder.input._type>,requestInput:unknown=args.input) => {
  const {input,ctx,tx,audit}=args;
  assertCommerceEnabled();
  if(ctx.membershipId===null && (input.channel!=='online'||input.customerId))invalid('public_order_scope');
  const hash=createHash('sha256').update(commerceFingerprint(requestInput)).digest('hex');
  await tx`select pg_advisory_xact_lock(hashtext(${ctx.locationId}),hashtext(${`purchase:${input.businessKey}`}))`;
  const [existing]=await tx<OrderRow[]>`select * from commerce_orders where location_id=${ctx.locationId} and idem_key=${input.businessKey} for update`;
  if(existing) {
    if(existing.request_hash!==hash)invalid('purchase_key_reused');
    auditOrder(audit,existing.id,existing.status);return resultOf(existing,await paymentOf(tx,existing.id));
  }
  const [location]=await tx<{currency:string;settings:Record<string,unknown>}[]>`select currency,settings from locations where id=${ctx.locationId}`;
  if(!location)absent('location');
  const settings=(location.settings.commerce??{}) as {salesEnabled?:boolean};
  if(!settings.salesEnabled)invalid('new_sales_disabled');
  let snapshot:PurchaseSnapshot={version:1,kind:input.kind,name:commerceText(ctx.locale,'gifts'),templateId:input.templateId??null,
    amountCents:0,currency:location.currency.toLowerCase(),faceValueCents:0,sessions:0,serviceIds:[],scope:'location',validDays:null,
    coverageMode:'bundle',commissionBasis:'face',recipientName:input.recipientName??null,recipientNote:input.recipientNote??null,
    recipientEmail:input.recipientEmail??null,consentVersion:'commerce-v1',consentAt:new Date().toISOString(),reason:input.reason??null};
  if(input.kind==='gift_card') {
    const config=(location.settings.gift_card??{}) as {commission_basis?:string};
    snapshot.commissionBasis=config.commission_basis==='sale'?'sale':'face';
    if(input.templateId) {
      const [t]=await tx<{name:unknown;face_value_cents:number;sale_price_cents:number;scope:'location'|'org';valid_days:number|null;online_sale:boolean}[]>`
        select * from gift_card_templates where id=${input.templateId} and location_id=${ctx.locationId} and active`;
      if(!t)absent('gift_card_template');
      if(input.channel==='online'&&!t.online_sale)invalid('product_not_for_online_sale');
      snapshot={...snapshot,name:pickText(t.name,ctx.locale),faceValueCents:t.face_value_cents,amountCents:t.sale_price_cents,scope:t.scope,validDays:t.valid_days};
    } else {
      if(input.channel==='online')invalid('online_purchase_requires_template');
      if(!input.faceValueCents||input.salePriceCents===undefined)invalid('missing_gift_card_price');
      snapshot.faceValueCents=input.faceValueCents;snapshot.amountCents=input.salePriceCents;
      snapshot.scope=input.scope??'location';
    }
    if(snapshot.amountCents>snapshot.faceValueCents)invalid('sale_price_above_face_value');
  } else {
    const [t]=await tx<{name:unknown;price_cents:number;sessions:number;service_ids:string[];scope:'location'|'org';valid_days:number|null;
      online_sale:boolean;coverage_mode:'bundle'|'any_included'|null;commission_basis:'catalog_price'|'sale_price'|'zero'|null}[]>`
      select * from package_templates where id=${input.templateId!} and location_id=${ctx.locationId} and active`;
    if(!t)absent('package_template');
    if(input.channel==='online'&&!t.online_sale)invalid('product_not_for_online_sale');
    const sessions=input.packageOverrides?.sessions??t.sessions;
    const validDays=input.packageOverrides?.validDays??t.valid_days;
    if(sessions===0&&(!validDays||t.service_ids.length===0))invalid('unlimited_requires_term_and_services');
    const policy=(location.settings.checkout??{}) as Record<string,unknown>;
    snapshot={...snapshot,unitAllocationVersion:2,name:pickText(t.name,ctx.locale),amountCents:input.packageOverrides?.priceCents??t.price_cents,sessions,serviceIds:t.service_ids,
      scope:t.scope,validDays,coverageMode:t.coverage_mode??(policy.packageCoverageMode==='any_included'?'any_included':'bundle'),
      commissionBasis:t.commission_basis??(policy.packageCommissionBasis==='catalog_price'?'catalog_price':policy.packageCommissionBasis==='zero'?'zero':'sale_price')};
  }
  if(input.expectedQuoteHash&&purchaseQuoteHash(snapshot)!==input.expectedQuoteHash)invalid('commerce_purchase_quote_changed');
  if(input.channel==='complimentary')snapshot.amountCents=0;
  else if(snapshot.amountCents<=0)invalid('use_complimentary_action_for_zero_price');
  if(input.channel==='offline'&&input.offlinePayment?.amountCents!==snapshot.amountCents)invalid('offline_payment_amount_mismatch');
  if(input.channel==='offline')await lockOpenDay(tx,ctx);
  let customerId=input.customerId??null;
  if(customerId) {
    const [customer]=await tx<{id:string}[]>`select id from customers where id=${customerId} and org_id=${ctx.orgId} and merged_into_id is null and blocked_at is null`;
    if(!customer)absent('customer');
  } else if(input.customer) {
    // Public input never grants access to assets of an existing phone/email holder.
    const [customer]=await tx<{id:string}[]>`insert into customers(org_id,primary_location_id,display_name,email,phone_e164,locale,source)
      values(${ctx.orgId},${ctx.locationId},${input.customer.name},${input.customer.email},${input.customer.phoneE164??null},${ctx.locale},'commerce') returning id`;
    customerId=customer!.id;
  }
  if(input.kind==='package'&&!customerId)invalid('package_requires_customer');
  let accountId:string|null=null;let stripeAccountId:string|null=null;let livemode=false;
  if(input.channel==='online') {
    livemode=commerceLiveMode();
    const [account]=await tx<{id:string;stripe_account_id:string;charges_enabled:boolean;disconnected:boolean;capabilities:Record<string,string>}[]>`
      select * from commerce_accounts where location_id=${ctx.locationId} and livemode=${livemode}`;
    if(!account||account.disconnected||!account.charges_enabled||account.capabilities.card_payments!=='active')invalid('connected_account_not_ready');
    accountId=account.id;stripeAccountId=account.stripe_account_id;
  }
  const [order]=await tx<OrderRow[]>`insert into commerce_orders(org_id,location_id,customer_id,account_id,kind,channel,status,amount_cents,currency,snapshot,idem_key,request_hash)
    values(${ctx.orgId},${ctx.locationId},${customerId},${accountId},${input.kind},${input.channel},${input.channel==='online'?'pending':'paid'},
      ${snapshot.amountCents},${snapshot.currency},${jsonb(snapshot)}::jsonb,${input.businessKey},${hash}) returning *`;
  let payment:PaymentRow|undefined;
  if(input.channel!=='complimentary') {
    [payment]=await tx<PaymentRow[]>`insert into commerce_payments(org_id,location_id,order_id,provider,method,status,amount_cents,currency,
      stripe_account_id,livemode,external_reference,recorded_by,paid_at)
      values(${ctx.orgId},${ctx.locationId},${order!.id},${input.channel==='online'?'stripe':'offline'},${input.offlinePayment?.method??'checkout'},
        ${input.channel==='online'?'pending':'paid'},${snapshot.amountCents},${snapshot.currency},${stripeAccountId},${livemode},
        ${input.offlinePayment?.reference??null},${ctx.membershipId},${input.channel==='offline'?new Date().toISOString():null}::timestamptz) returning *`;
  }
  if(input.channel==='online') {await queueTask(tx,ctx,'checkout',order!.id);await queueTask(tx,ctx,'reconcile',order!.id,30);}
  else await fulfill(args,order!);
  auditOrder(audit,order!.id,order!.status);
  return resultOf(order!,payment);
};
registerHandler(CommerceCreateOrder,createOrderInTransaction);
registerHandler(CommercePublicOrder,createOrderInTransaction);

export async function queueTask(tx:Tx,ctx:Ctx,kind:string,subjectId:string,delaySec=0) {
  await tx`insert into commerce_tasks(org_id,location_id,kind,subject_id,retry_at) values(${ctx.orgId},${ctx.locationId},${kind},${subjectId},now()+${delaySec}::int*interval '1 second')
    on conflict(kind,subject_id) do nothing`;
}
registerHandler(CommerceSaveSettings,async({input,ctx,tx,audit})=>{
  await tx`update locations set settings=jsonb_set(settings,'{commerce}',${jsonb(input)}::jsonb) where id=${ctx.locationId}`;
  audit({entityType:'location',entityId:ctx.locationId,after:input});return {saved:true};
});
registerHandler(CommerceResendNotice,async({input,ctx,tx,audit})=>{
  const [order]=await tx<OrderRow[]>`select * from commerce_orders where id=${input.orderId} and location_id=${ctx.locationId} for update`;
  if(!order)throw new AppError(ERROR_CODES.NOT_FOUND);
  if(order.kind==='customer_membership')invalid('membership_notice_requires_invoice_scope');
  if(order.status!=='fulfilled')invalid('purchase_not_fulfilled');
  const [customer]=order.customer_id?await tx<{email:string|null}[]>`select email from customers where id=${order.customer_id}`:[];
  if(!customer?.email&&!order.snapshot.recipientEmail)invalid('delivery_address_missing');
  if(order.kind==='gift_card'){
    const [card]=await tx<{credential_disabled:boolean;status:string;expires_at:Date|null}[]>`select credential_disabled,status,expires_at from gift_cards where id=${order.asset_id!} for update`;
    if(!card||card.credential_disabled||['void','expired'].includes(card.status)||(card.expires_at&&new Date(card.expires_at).getTime()<Date.now()))invalid('gift_card_inactive');
  }
  await queueCommerceNotice(tx,ctx,order,'delivery',randomUUID());
  audit({entityType:'commerce_order',entityId:order.id,after:{deliveryQueued:true,reason:input.reason}});return {queued:true};
});
registerHandler(CommerceSaveAccount,async({input,ctx,tx,audit})=>{
  const [existing]=await tx<{id:string;stripe_account_id:string;api_version:string;disconnected:boolean}[]>`select id,stripe_account_id,api_version,disconnected from commerce_accounts where location_id=${ctx.locationId} and livemode=${input.livemode} for update`;
  if(existing&&existing.stripe_account_id!==input.stripeAccountId)invalid('account_replacement_requires_migration');
  if(existing?.api_version==='v2'&&input.apiVersion!=='v2')invalid('account_api_version_downgrade');
  if(input.sourceEvent&&existing){
    // A shared merchant account may map to several locations: refresh/deduplicate each projection independently.
    const eventKey=`${input.sourceEvent.id}:${ctx.locationId}`;
    const [event]=await tx`insert into commerce_events(org_id,location_id,stripe_account_id,livemode,event_id,event_type,object_id)
      values(${ctx.orgId},${ctx.locationId},${input.stripeAccountId},${input.livemode},${eventKey},${input.sourceEvent.type},${input.stripeAccountId})
      on conflict(stripe_account_id,livemode,event_id) do nothing returning id`;
    if(!event){audit({entityType:'commerce_account',entityId:existing.id,after:{duplicateEvent:input.sourceEvent.id}});return {accountId:existing.id};}
    if(existing.disconnected&&!input.disconnected){audit({entityType:'commerce_account',entityId:existing.id,after:{ignoredAutomaticReconnection:true}});return {accountId:existing.id};}
  }
  const [row]=await tx<{id:string}[]>`insert into commerce_accounts(org_id,location_id,stripe_account_id,livemode,charges_enabled,payouts_enabled,details_submitted,disconnected,capabilities,requirements,api_version)
    values(${ctx.orgId},${ctx.locationId},${input.stripeAccountId},${input.livemode},${input.chargesEnabled},${input.payoutsEnabled},${input.detailsSubmitted},
      ${input.disconnected},${jsonb(input.capabilities)}::jsonb,${jsonb(input.requirements)}::jsonb,${input.apiVersion})
    on conflict(location_id,livemode) do update set charges_enabled=excluded.charges_enabled,payouts_enabled=excluded.payouts_enabled,
      details_submitted=excluded.details_submitted,disconnected=excluded.disconnected,capabilities=excluded.capabilities,requirements=excluded.requirements,api_version=excluded.api_version,refreshed_at=now()
    returning id`;
  await queueTask(tx,ctx,'payout_scan',row!.id,3600);
  audit({entityType:'commerce_account',entityId:row!.id,after:{chargesEnabled:input.chargesEnabled,disconnected:input.disconnected}});return {accountId:row!.id};
});
registerHandler(CommerceDisconnectAccount,async({input,ctx,tx,audit})=>{
  const [account]=await tx<{id:string}[]>`update commerce_accounts set disconnected=true,charges_enabled=false,refreshed_at=now()
    where location_id=${ctx.locationId} and stripe_account_id=${input.stripeAccountId} and livemode=${input.livemode} returning id`;
  audit({entityType:'commerce_account',...(account?{entityId:account.id}:{}),after:{disconnected:!!account,eventId:input.eventId}});
  return {disconnected:!!account};
});
registerHandler(CommerceRecordPayment,async(args)=>{
  const {input,ctx,tx,audit}=args;
  await lockMembershipOrder(tx,input.orderId);await lockDepositOrder(tx,ctx,input.orderId);
  const [o]=await tx<OrderRow[]>`select * from commerce_orders where id=${input.orderId} and location_id=${ctx.locationId} for update`;
  if(!o)absent('commerce_order');
  const p=await paymentOf(tx,o.id);
  if(!p||p.provider!=='stripe'||p.stripe_account_id!==input.stripeAccountId||p.livemode!==input.livemode||p.amount_cents!==input.amountCents
    ||p.currency!==input.currency||(p.checkout_session_id&&p.checkout_session_id!==input.sessionId)
    ||(p.payment_intent_id&&p.payment_intent_id!==input.paymentIntentId))invalid('payment_context_mismatch');
  const [event]=await tx<{id:string}[]>`insert into commerce_events(org_id,location_id,stripe_account_id,livemode,event_id,event_type,object_id)
    values(${ctx.orgId},${ctx.locationId},${input.stripeAccountId},${input.livemode},${input.eventId},${input.eventType},${input.sessionId})
    on conflict(stripe_account_id,livemode,event_id) do nothing returning id`;
  if(event && (p.status==='pending'||(p.status==='failed'&&o.status==='canceled'))) {
    const [risk]=await tx<{frozen:boolean;disputed:boolean}[]>`select count(*)>0 as frozen,bool_or(kind='dispute') as disputed
      from commerce_review_items where payment_id=${p.id} and status in ('open','lost','review')`;
    p.status=risk?.disputed?'disputed':'paid';
    await tx`update commerce_payments set status=${p.status},paid_at=now(),checkout_session_id=${input.sessionId},payment_intent_id=${input.paymentIntentId} where id=${p.id}`;
    o.status=risk?.frozen?'review':'paid';
    await tx`update commerce_orders set status=${o.status},updated_at=now() where id=${o.id}`;
    if(!risk?.frozen)await fulfill(args,o);
  }
  auditOrder(audit,o.id,o.status);return resultOf(o,p);
});
registerHandler(CommerceExpireOrder,async({input,ctx,tx,audit})=>{
  await lockMembershipOrder(tx,input.orderId);await lockDepositOrder(tx,ctx,input.orderId);
  const [o]=await tx<OrderRow[]>`select * from commerce_orders where id=${input.orderId} for update`;
  const p=o?await paymentOf(tx,o.id):undefined;
  if(!o||!p||p.stripe_account_id!==input.stripeAccountId||p.livemode!==input.livemode||p.checkout_session_id!==input.sessionId)invalid('checkout_context_mismatch');
  const expired=p.status==='pending'&&o.status==='pending';
  if(expired) {
    await tx`update commerce_payments set status='failed' where id=${p.id}`;
    await tx`update commerce_orders set status='canceled',updated_at=now() where id=${o.id}`;
  }
  auditOrder(audit,o.id,expired?'canceled':o.status);return {expired};
});

registerHandler(CommerceRecordRisk,async(args)=>{
  const {input,ctx,tx,audit}=args;
  const [link]=await tx<PaymentRow[]>`select * from commerce_payments where provider='stripe' and stripe_account_id=${input.stripeAccountId}
    and livemode=${input.livemode} and (payment_intent_id=${input.paymentIntentId}
      or (order_id=${input.orderId??null}::uuid and payment_intent_id is null))`;
  if(!link)absent('commerce_payment');
  await lockMembershipOrder(tx,link.order_id);await lockDepositOrder(tx,ctx,link.order_id);
  const [o]=await tx<OrderRow[]>`select * from commerce_orders where id=${link.order_id} for update`;
  const [p]=await tx<PaymentRow[]>`select * from commerce_payments where id=${link.id} for update`;
  if(!o||!p||p.currency!==input.currency||(p.payment_intent_id&&p.payment_intent_id!==input.paymentIntentId))invalid('risk_context_mismatch');
  const status=input.kind==='dispute'
    ?(['won','warning_closed','prevented'].includes(input.providerStatus)?'won':input.providerStatus==='lost'?'lost':'open')
    :(['failed','canceled'].includes(input.providerStatus)?'resolved':'review');
  const [event]=await tx<{id:string}[]>`insert into commerce_events(org_id,location_id,stripe_account_id,livemode,event_id,event_type,object_id)
    values(${ctx.orgId},${ctx.locationId},${input.stripeAccountId},${input.livemode},${input.eventId},${input.eventType},${input.externalId})
    on conflict(stripe_account_id,livemode,event_id) do nothing returning id`;
  if(event)await tx`insert into commerce_review_items(org_id,location_id,payment_id,stripe_account_id,livemode,kind,external_id,amount_cents,currency,status,provider_status,event_created)
    values(${ctx.orgId},${ctx.locationId},${p.id},${input.stripeAccountId},${input.livemode},${input.kind},${input.externalId},${input.amountCents},${input.currency},
      ${status},${input.providerStatus},${input.eventCreated})
    on conflict(stripe_account_id,livemode,kind,external_id) do update set status=excluded.status,provider_status=excluded.provider_status,
      event_created=excluded.event_created,updated_at=now()
    where commerce_review_items.payment_id=excluded.payment_id and commerce_review_items.event_created<=excluded.event_created
      and not(commerce_review_items.status in ('won','lost','resolved') and excluded.status in ('open','review'))`;
  const [state]=await tx<{frozen:boolean;disputed:boolean}[]>`select count(*)>0 as frozen,bool_or(kind='dispute') as disputed
    from commerce_review_items where payment_id=${p.id} and status in ('open','lost','review')`;
  const frozen=state?.frozen??false;
  if(o.asset_id&&o.kind==='gift_card')await tx`update gift_cards set commerce_frozen=${frozen} where id=${o.asset_id}`;
  if(o.asset_id&&o.kind==='package')await tx`update customer_packages set commerce_frozen=${frozen} where id=${o.asset_id}`;
  if(o.kind==='customer_membership')await tx`update customer_paid_memberships m set commerce_frozen=
    exists(select 1 from customer_membership_terminations t where t.membership_id=m.id and t.status='pending') or
    exists(select 1 from commerce_review_items r join commerce_payments rp on rp.id=r.payment_id
      where r.status in('open','lost','review') and (rp.order_id=m.original_order_id or
        exists(select 1 from customer_membership_invoices i where i.membership_id=m.id and i.payment_id=rp.id))),updated_at=now()
    where m.original_order_id=${o.id} or exists(select 1 from customer_membership_invoices i where i.membership_id=m.id and i.order_id=${o.id})`;
  if(o.kind==='deposit'){
    const [h]=await tx<{id:string}[]>`update commerce_appointment_holds h set commerce_frozen=exists(
      select 1 from commerce_deposit_requests dr join commerce_payments dp on dp.order_id=dr.order_id join commerce_review_items ri on ri.payment_id=dp.id
      where dr.hold_id=h.id and ri.status in('open','lost','review'))
      where exists(select 1 from commerce_deposit_requests r where r.hold_id=h.id and r.order_id=${o.id}) returning h.id`;
    if(h)await refreshDepositFinancialState(tx,h.id);
  }
  if(p.status==='paid'||p.status==='disputed') {
    p.status=state?.disputed?'disputed':'paid';await tx`update commerce_payments set status=${p.status} where id=${p.id}`;
  }
  // The signed risk fact may precede Checkout completion; retain a reference without inventing a paid fact.
  if(!p.payment_intent_id)await tx`update commerce_payments set payment_intent_id=${input.paymentIntentId} where id=${p.id}`;
  if(!['refunded','refund_pending'].includes(o.status)) {
    o.status=frozen?'review':o.asset_id?'fulfilled':p.status==='pending'?'pending':'paid';
    await tx`update commerce_orders set status=${o.status},updated_at=now() where id=${o.id}`;
    if(o.status==='paid'&&!o.asset_id)await fulfill(args,o);
  }
  audit({entityType:'commerce_order',entityId:o.id,after:{riskKind:input.kind,status:o.status,externalId:input.externalId}});
  return {recorded:!!event,frozen};
});
registerHandler(CommerceRecordSettlement,async({input,ctx,tx,audit})=>{
  if(input.netCents!==input.grossCents-input.feeCents)invalid('settlement_value_mismatch');
  const [link]=input.target==='payment'
    ?await tx<{order_id:string;payment_id:string}[]>`select order_id,id as payment_id from commerce_payments where id=${input.id}`
    :await tx<{order_id:string;payment_id:string}[]>`select p.order_id,p.id as payment_id from commerce_refunds r join commerce_payments p on p.id=r.payment_id where r.id=${input.id}`;
  if(!link)absent('commerce_payment');
  await lockMembershipOrder(tx,link.order_id);await tx`select id from commerce_orders where id=${link.order_id} for update`;
  const [p]=await tx<PaymentRow[]>`select * from commerce_payments where id=${link.payment_id} for update`;
  if(!p||p.provider!=='stripe'||!['paid','refunded','disputed'].includes(p.status)||p.stripe_account_id!==input.stripeAccountId||p.livemode!==input.livemode)invalid('settlement_context_mismatch');
  const [target]=input.target==='payment'
    ?await tx<{amount_cents:number;balance_transaction_id:string|null;fee_cents:number|null;net_cents:number|null;currency:string;provider_id:string|null}[]>`
      select amount_cents,balance_transaction_id,fee_cents,net_cents,currency,charge_id as provider_id from commerce_payments where id=${input.id}`
    :await tx<{amount_cents:number;balance_transaction_id:string|null;fee_cents:number|null;net_cents:number|null;currency:string;provider_id:string|null}[]>`
      select r.amount_cents,r.balance_transaction_id,r.fee_cents,r.net_cents,p.currency,r.stripe_refund_id as provider_id from commerce_refunds r
      join commerce_payments p on p.id=r.payment_id where r.id=${input.id} for update of r`;
  if(!target||target.amount_cents!==input.originalAmountCents||(target.provider_id&&target.provider_id!==input.providerId)
    ||(target.balance_transaction_id&&(target.balance_transaction_id!==input.balanceTransactionId||target.fee_cents!==input.feeCents||target.net_cents!==input.netCents)))invalid('settlement_fact_changed');
  if(input.currency===p.currency&&input.grossCents!==(input.target==='payment'?target.amount_cents:-target.amount_cents))invalid('settlement_gross_mismatch');
  if(input.target==='payment')await tx`update commerce_payments set charge_id=${input.providerId},balance_transaction_id=${input.balanceTransactionId},
    settlement_currency=${input.currency},settlement_gross_cents=${input.grossCents},fee_cents=${input.feeCents},net_cents=${input.netCents},
    paid_at=${input.occurredAt}::timestamptz,available_on=${input.availableOn}::timestamptz where id=${input.id}`;
  else await tx`update commerce_refunds set balance_transaction_id=${input.balanceTransactionId},settlement_currency=${input.currency},
    settlement_gross_cents=${input.grossCents},fee_cents=${input.feeCents},net_cents=${input.netCents},available_on=${input.availableOn}::timestamptz where id=${input.id}`;
  audit({entityType:`commerce_${input.target}`,entityId:input.id,after:{settlementRecorded:true,balanceTransactionId:input.balanceTransactionId}});
  return {recorded:true};
});

export const requestRefundInTransaction=async({input,ctx,tx,audit}:HandlerArgs<typeof CommerceRequestRefund.input._type>,verifiedExternalRefund?:string,
  options?:{guestCancellationId?:string;requireReview?:boolean;retentionReleaseId?:string;depositGuestAllocation?:Array<{guestIndex:number;amountCents:number}>})=>{
  const [link]=await tx<{order_id:string}[]>`select order_id from commerce_payments where id=${input.paymentId} and location_id=${ctx.locationId}`;
  if(!link)absent('commerce_payment');
  await lockMembershipOrder(tx,link.order_id);await lockDepositOrder(tx,ctx,link.order_id);
  const [o]=await tx<OrderRow[]>`select * from commerce_orders where id=${link.order_id} for update`;
  const [p]=await tx<PaymentRow[]>`select * from commerce_payments where id=${input.paymentId} for update`;
  if(!o||!p||p.status!=='paid'||(o.status==='review'&&!verifiedExternalRefund))invalid('payment_not_refundable');
  const [aggregate]=await tx<{reserved:number;quantity:number}[]>`select coalesce(sum(amount_cents),0)::int as reserved,
    coalesce(sum(asset_quantity),0)::int as quantity from commerce_refunds where payment_id=${p.id} and status in ('pending','succeeded','review')`;
  if(input.amountCents>p.amount_cents-aggregate!.reserved)invalid('refund_exceeds_payment');
  let quantity=0;
  let reservedUnits:string|null=null;
  let guestAllocation:Array<{guestIndex:number;amountCents:number}>|null=null;
  if(input.depositGuestIndices&&o.kind!=='deposit')invalid('refund_guest_selection_requires_deposit');
  if(options?.requireReview&&(!options.guestCancellationId||o.kind!=='deposit'))invalid('refund_review_context_missing');
  if(o.kind==='deposit'&&o.asset_id) {
    const [h]=await tx<{reserved_cents:number}[]>`select reserved_cents from commerce_appointment_holds
      where id=${o.asset_id} and exists(select 1 from commerce_deposit_requests r where r.hold_id=commerce_appointment_holds.id and r.order_id=${o.id}) for update`;
    const source=(await depositPaymentSources(tx,ctx,o.asset_id)).find(s=>s.paymentId===p.id);
    if(!h||!source||input.amountCents>source.balanceCents-source.reservedCents)invalid('refund_exceeds_unused_deposit');
    const guests=source.guests;
    if(input.depositGuestIndices&&!guests)invalid('deposit_guest_refund_requires_review');
    if(guests){try{guestAllocation=allocateDepositRefundByGuest(guests.map(g=>({guestIndex:g.guestIndex,amountCents:g.availableCents})),input.amountCents,input.depositGuestIndices);}
      catch{invalid('refund_exceeds_selected_guest_deposit');}}
    if(options?.depositGuestAllocation){
      const exact=options.depositGuestAllocation;
      if(!options.retentionReleaseId||!guests||new Set(exact.map(g=>g.guestIndex)).size!==exact.length
       ||exact.reduce((n,g)=>n+g.amountCents,0)!==input.amountCents
       ||exact.some(g=>!Number.isSafeInteger(g.amountCents)||g.amountCents<=0||g.amountCents>(guests.find(x=>x.guestIndex===g.guestIndex)?.availableCents??0)))invalid('deposit_retention_refund_allocation_invalid');
      guestAllocation=exact;
    }
    quantity=input.amountCents;
    await tx`update commerce_appointment_holds set reserved_cents=reserved_cents+${quantity},status='refund_pending',updated_at=now() where id=${o.asset_id}`;
  } else if(o.kind==='gift_card'&&o.asset_id) {
    const [g]=await tx<{face_value_cents:number;sale_price_cents:number;reserved_cents:number;balance:number}[]>`
      select g.face_value_cents,g.sale_price_cents,g.reserved_cents,
        (select coalesce(sum(amount_cents),0)::int from customer_credit_ledger where kind='gift_card' and subject_id=g.id) as balance
      from gift_cards g where id=${o.asset_id} for update of g`;
    if(!g)absent('gift_card');
    // Additional gifted/manual face value has no cash purchase allocation in the legacy ledger.
    // It must never raise the purchase's refundable cash merely by increasing total card balance.
    const [unattributed]=await tx`select id from customer_credit_ledger where kind='gift_card' and subject_id=${o.asset_id}
      and entry='adjust' and amount_cents>0 limit 1`;
    if(unattributed)invalid('gift_purchase_basis_requires_review');
    if(input.amountCents>giftPurchaseRefundLimit(g.sale_price_cents,g.face_value_cents,Math.min(g.face_value_cents,g.balance-g.reserved_cents)))invalid('refund_exceeds_unused_value');
    quantity=giftFaceForRefund(input.amountCents+aggregate!.reserved,g.sale_price_cents,g.face_value_cents)-aggregate!.quantity;
    if(quantity<=0||quantity>g.balance-g.reserved_cents)invalid('refund_exceeds_unused_value');
    await tx`update gift_cards set reserved_cents=reserved_cents+${quantity} where id=${o.asset_id}`;
  } else if(o.kind==='package'&&o.asset_id) {
    const [g]=await tx<{remaining_sessions:number;reserved_sessions:number;total_sessions:number;refund_frozen:boolean;available_units:string;purchase_snapshot:PurchaseSnapshot}[]>`select * from customer_packages where id=${o.asset_id} for update`;
    if(!g||g.refund_frozen)invalid('package_refund_in_progress');
    if(g.total_sessions===0){
      if(!verifiedExternalRefund&&!input.unlimitedTerminationConfirmed)invalid('unlimited_refund_requires_termination_confirmation');
      await tx`update customer_packages set refund_frozen=true where id=${o.asset_id}`;
    }
    else {
      if(o.snapshot.unitAllocationVersion!==2)invalid('legacy_package_allocation_requires_review');
      const allocation=(()=>{try{return refundPackageUnits(o.amount_cents,g.total_sessions,availablePackageUnits(g),input.amountCents);}catch{invalid('refund_requires_whole_unused_sessions');}})();
      quantity=packageRangeCount(allocation.taken);reservedUnits=formatPackageUnitRanges(allocation.taken);
      await tx`update customer_packages set reserved_sessions=reserved_sessions+${quantity},refund_frozen=true,available_units=${formatPackageUnitRanges(allocation.remaining)}::int4multirange where id=${o.asset_id}`;
    }
  } else if(!verifiedExternalRefund||o.asset_id||input.amountCents!==p.amount_cents-aggregate!.reserved)invalid('purchase_asset_missing');
  const status=options?.requireReview?'review':'pending';
  const [refund]=await tx<{id:string}[]>`insert into commerce_refunds(org_id,location_id,payment_id,amount_cents,asset_quantity,reason,recorded_by,reserved_unit_ranges,
    deposit_guest_allocation,guest_cancellation_id,review_required,status,retention_release_id)
    values(${ctx.orgId},${ctx.locationId},${p.id},${input.amountCents},${quantity},${input.reason},${ctx.membershipId},${reservedUnits}::int4multirange,
      ${guestAllocation?jsonb(guestAllocation):null}::jsonb,${options?.guestCancellationId??null},${!!options?.requireReview},${status},${options?.retentionReleaseId??null}) returning id`;
  if(p.provider==='stripe'&&!verifiedExternalRefund&&!options?.requireReview)await queueTask(tx,ctx,'refund',refund!.id);
  audit({entityType:'commerce_refund',entityId:refund!.id,after:{status,reason:input.reason}});
  return {refundId:refund!.id,status};
};
registerHandler(CommerceRequestRefund,requestRefundInTransaction);
registerHandler(CommerceApproveGuestRefund,async({input,ctx,tx,audit})=>{
  if(!ctx.membershipId)throw new AppError(ERROR_CODES.PERMISSION_DENIED);
  const [link]=await tx<{order_id:string}[]>`select p.order_id from commerce_refunds r join commerce_payments p on p.id=r.payment_id
    where r.id=${input.refundId} and r.location_id=${ctx.locationId}`;
  if(!link)absent('commerce_refund');await lockMembershipOrder(tx,link.order_id);await lockDepositOrder(tx,ctx,link.order_id);
  const [r]=await tx<{id:string;status:string;review_required:boolean;guest_cancellation_id:string|null;approved_at:string|null;approval_reason:string|null;provider:string}[]>`
    select r.*,p.provider from commerce_refunds r join commerce_payments p on p.id=r.payment_id where r.id=${input.refundId} for update of r`;
  if(!r||!r.review_required||!r.guest_cancellation_id)invalid('refund_not_guest_review');
  if(r.approved_at){if(r.approval_reason!==input.reason)invalid('refund_approval_changed');
    audit({entityType:'commerce_refund',entityId:r.id,after:{replayed:true,status:r.status}});return {refundId:r.id,status:r.status};}
  if(r.status!=='review')invalid('refund_not_pending_review');
  await tx`update commerce_refunds set status='pending',approved_at=now(),approved_by=${ctx.membershipId},approval_reason=${input.reason} where id=${r.id}`;
  if(r.provider==='stripe')await queueTask(tx,ctx,'refund',r.id);
  audit({entityType:'commerce_refund',entityId:r.id,after:{status:'pending',approvalReason:input.reason}});
  return {refundId:r.id,status:'pending'};
});
const completeRefund = async({input,ctx,tx,audit}:HandlerArgs<typeof CommerceCompleteRefund.input._type>)=>{
  const [link]=await tx<{order_id:string}[]>`select p.order_id from commerce_refunds r join commerce_payments p on p.id=r.payment_id where r.id=${input.refundId}`;
  if(!link)absent('commerce_refund');
  await lockMembershipOrder(tx,link.order_id);await lockDepositOrder(tx,ctx,link.order_id);
  const [o]=await tx<OrderRow[]>`select * from commerce_orders where id=${link.order_id} for update`;
  const [r]=await tx<{id:string;payment_id:string;amount_cents:number;asset_quantity:number;status:string;stripe_refund_id:string|null;reserved_unit_ranges:string|null;
    membership_refund_request_id:string|null;guest_cancellation_id:string|null;deposit_guest_allocation:Array<{guestIndex:number;amountCents:number}>|null}[]>`select * from commerce_refunds where id=${input.refundId} for update`;
  const [p]=await tx<PaymentRow[]>`select * from commerce_payments where id=${r!.payment_id} for update`;
  if(!o||!p||r!.amount_cents!==input.amountCents||p.stripe_account_id!==input.stripeAccountId||p.livemode!==input.livemode
    ||(r!.stripe_refund_id&&r!.stripe_refund_id!==input.stripeRefundId))invalid('refund_context_mismatch');
  if(r!.membership_refund_request_id){const [t]=await tx<{status:string}[]>`select t.status from customer_membership_terminations t join customer_membership_refund_requests q on q.termination_id=t.id where q.id=${r!.membership_refund_request_id}`;
    if(!t||t.status==='pending')invalid('membership_cancellation_not_confirmed');}
  if(input.event){
    if(p.provider!=='stripe'||!input.stripeAccountId||!input.stripeRefundId)invalid('refund_event_context_missing');
    const [recorded]=await tx<{id:string}[]>`insert into commerce_events(org_id,location_id,stripe_account_id,livemode,event_id,event_type,object_id)
      values(${ctx.orgId},${ctx.locationId},${input.stripeAccountId},${input.livemode},${input.event.id},${input.event.type},${input.stripeRefundId})
      on conflict(stripe_account_id,livemode,event_id) do nothing returning id`;
    if(!recorded){
      const [previous]=await tx<{object_id:string;event_type:string}[]>`select object_id,event_type from commerce_events
        where stripe_account_id=${input.stripeAccountId} and livemode=${input.livemode} and event_id=${input.event.id}`;
      if(previous?.object_id!==input.stripeRefundId||previous.event_type!==input.event.type)invalid('refund_event_context_mismatch');
    }
  }
  if(r!.status==='pending'&&input.status!=='pending') {
    if(o.kind==='deposit'&&o.asset_id) {
      const [h]=await tx<{reserved_cents:number;appointment_id:string;appointment_status:string;waived_at:string|null}[]>`select h.reserved_cents,h.appointment_id,h.waived_at,a.status as appointment_status
        from commerce_appointment_holds h join appointments a on a.id=h.appointment_id where h.id=${o.asset_id} for update of h`;
      if(!h||h.reserved_cents<r!.asset_quantity||r!.asset_quantity!==r!.amount_cents)invalid('deposit_refund_reservation_inconsistent');
      if(input.status==='succeeded')await tx`insert into commerce_deposit_ledger(org_id,location_id,hold_id,payment_id,refund_id,entry,amount_cents,reference,guest_allocation)
        values(${ctx.orgId},${ctx.locationId},${o.asset_id},${p.id},${r!.id},'refund',${-r!.amount_cents},${`refund:${r!.id}`},
          ${r!.deposit_guest_allocation?jsonb(r!.deposit_guest_allocation):null}::jsonb)`;
      await tx`update commerce_appointment_holds set reserved_cents=reserved_cents-${r!.asset_quantity},updated_at=now() where id=${o.asset_id}`;
      await refreshDepositFinancialState(tx,o.asset_id);
    } else if(o.kind==='gift_card'&&o.asset_id) {
      const [g]=await tx<{balance_cents:number;reserved_cents:number;holder_customer_id:string|null}[]>`select * from gift_cards where id=${o.asset_id} for update`;
      const [b]=await tx<{balance:number}[]>`select coalesce(sum(amount_cents),0)::int as balance from customer_credit_ledger where kind='gift_card' and subject_id=${o.asset_id}`;
      const after=b!.balance-(input.status==='succeeded'?r!.asset_quantity:0);
      if(after<0||g!.reserved_cents<r!.asset_quantity)invalid('refund_reservation_inconsistent');
      if(input.status==='succeeded')await tx`insert into customer_credit_ledger(org_id,location_id,kind,subject_id,customer_id,entry,amount_cents,balance_after_cents,reason,actor_membership_id,meta)
        values(${ctx.orgId},${ctx.locationId},'gift_card',${o.asset_id},${g!.holder_customer_id},'adjust',${-r!.asset_quantity},${after},'purchase_refund',${ctx.membershipId},${jsonb({refundId:r!.id})}::jsonb)`;
      await tx`update gift_cards set reserved_cents=reserved_cents-${r!.asset_quantity},balance_cents=${after},
        status=case when ${after}=0 then 'void' else status end,updated_at=now() where id=${o.asset_id}`;
    } else if(o.kind==='package'&&o.asset_id) {
      const [g]=await tx<{remaining_sessions:number;reserved_sessions:number;total_sessions:number;available_units:string}[]>`select * from customer_packages where id=${o.asset_id} for update`;
      if(!g||g.reserved_sessions<r!.asset_quantity)invalid('refund_reservation_inconsistent');
      const next=g.remaining_sessions-(input.status==='succeeded'?r!.asset_quantity:0);
      const reserved=parsePackageUnitRanges(r!.reserved_unit_ranges??'{}',g.total_sessions);
      if(g.total_sessions>0&&packageRangeCount(reserved)!==r!.asset_quantity)invalid('refund_reservation_inconsistent');
      const nextAvailable=input.status==='failed'?formatPackageUnitRanges(restorePackageUnits(parsePackageUnitRanges(g.available_units,g.total_sessions),reserved)):g.available_units;
      await tx`update customer_packages set remaining_sessions=${next},reserved_sessions=reserved_sessions-${r!.asset_quantity},refund_frozen=false,
        available_units=${nextAvailable}::int4multirange,
        status=case when ${input.status==='succeeded'&&(g.total_sessions===0||next===0)} then 'void' else status end,updated_at=now() where id=${o.asset_id}`;
      if(input.status==='succeeded')await tx`insert into customer_package_ledger(org_id,location_id,package_id,entry,quantity,value_cents,reference,unit_ranges)
        values(${ctx.orgId},${ctx.locationId},${o.asset_id},'purchase_refund',${-r!.asset_quantity},${-input.amountCents},${`refund:${r!.id}`},${r!.reserved_unit_ranges}::int4multirange)`;
    }
    await tx`update commerce_refunds set status=${input.status},stripe_refund_id=${input.stripeRefundId},completed_at=now() where id=${r!.id}`;
    r!.status=input.status;
    if(r!.membership_refund_request_id){const [q]=await tx<{termination_id:string}[]>`select termination_id from customer_membership_refund_requests where id=${r!.membership_refund_request_id}`;await syncMembershipTermination(tx,q!.termination_id);}
    if(input.status==='failed'&&r!.guest_cancellation_id){
      // Keep the cancelled guest's money unavailable until a human approves a fresh refund attempt.
      await requestRefundInTransaction({input:{paymentId:p.id,amountCents:r!.amount_cents,reason:'failed_guest_cancellation_refund_requires_review',
        depositGuestIndices:r!.deposit_guest_allocation!.map(g=>g.guestIndex)},ctx,tx,audit,emit:()=>{}},undefined,
        {guestCancellationId:r!.guest_cancellation_id,requireReview:true});
    }
    if(input.status==='succeeded')await queueCommerceNotice(tx,ctx,o,'refund',r!.id,input.amountCents);
    const [total]=await tx<{amount:number}[]>`select coalesce(sum(amount_cents),0)::int as amount from commerce_refunds where payment_id=${p.id} and status='succeeded'`;
    if(total!.amount===p.amount_cents) {
      if(o.kind==='package'&&o.asset_id) {
        const [asset]=await tx<{remaining_sessions:number;available_units:string}[]>`select remaining_sessions,available_units from customer_packages where id=${o.asset_id} for update`;
        if(asset!.remaining_sessions>0)await tx`insert into customer_package_ledger(org_id,location_id,package_id,entry,quantity,value_cents,reference,unit_ranges)
          values(${ctx.orgId},${ctx.locationId},${o.asset_id},'purchase_refund',${-asset!.remaining_sessions},0,${`full-refund-residual:${p.id}`},${asset!.available_units}::int4multirange)`;
        await tx`update customer_packages set remaining_sessions=0,available_units='{}'::int4multirange,status='void',updated_at=now() where id=${o.asset_id}`;
      }
      await tx`update commerce_payments set status='refunded' where id=${p.id}`;
      await tx`update commerce_orders set status='refunded',updated_at=now() where id=${o.id}`;
    }
  } else if(r!.status==='pending')await tx`update commerce_refunds set stripe_refund_id=${input.stripeRefundId} where id=${r!.id}`;
  audit({entityType:'commerce_refund',entityId:r!.id,after:{status:r!.status}});return {refundId:r!.id,status:r!.status};
};
registerHandler(CommerceCompleteRefund,completeRefund);
registerHandler(CommerceApplyExternalRefund,async(args)=>{
  const {input,ctx,tx,audit}=args;
  const [link]=await tx<{payment_id:string;order_id:string}[]>`select r.payment_id,p.order_id from commerce_review_items r join commerce_payments p on p.id=r.payment_id where r.id=${input.reviewId}`;
  if(!link)absent('commerce_review');
  const [o]=await tx<OrderRow[]>`select * from commerce_orders where id=${link.order_id} for update`;
  const [review]=await tx<{status:string;kind:string;external_id:string;amount_cents:number;provider_status:string;stripe_account_id:string;livemode:boolean}[]>`
    select * from commerce_review_items where id=${input.reviewId} for update`;
  if(review?.kind!=='external_refund'||review.provider_status!=='succeeded')invalid('external_refund_not_confirmed');
  const [existing]=await tx<{id:string;status:string}[]>`select id,status from commerce_refunds where payment_id=${link.payment_id} and stripe_refund_id=${review.external_id}`;
  if(review.status==='resolved'&&existing){auditOrder(audit,o!.id,o!.status);return {refundId:existing.id,status:existing.status};}
  if(review.status!=='review'||existing)invalid('external_refund_already_applied');
  const created=await requestRefundInTransaction({...args,input:{paymentId:link.payment_id,amountCents:review.amount_cents,reason:input.reason}},review.external_id);
  const result=await completeRefund({...args,input:{refundId:created.refundId,stripeRefundId:review.external_id,status:'succeeded',
    stripeAccountId:review.stripe_account_id,livemode:review.livemode,amountCents:review.amount_cents}});
  await tx`update commerce_review_items set status='resolved',updated_at=now() where id=${input.reviewId}`;
  const [state]=await tx<{frozen:boolean}[]>`select count(*)>0 as frozen from commerce_review_items where payment_id=${link.payment_id} and status in ('open','lost','review')`;
  if(o?.asset_id&&o.kind==='gift_card')await tx`update gift_cards set commerce_frozen=${state!.frozen} where id=${o.asset_id}`;
  if(o?.asset_id&&o.kind==='package')await tx`update customer_packages set commerce_frozen=${state!.frozen} where id=${o.asset_id}`;
  if(o?.asset_id&&o.kind==='deposit'){
    await tx`update commerce_appointment_holds h set commerce_frozen=exists(select 1 from commerce_deposit_requests dr join commerce_payments dp on dp.order_id=dr.order_id
      join commerce_review_items ri on ri.payment_id=dp.id where dr.hold_id=h.id and ri.status in('open','lost','review')) where h.id=${o.asset_id}`;
    await refreshDepositFinancialState(tx,o.asset_id);
  }
  await tx`update commerce_orders set status=case when status='refunded' then status when ${state!.frozen} then 'review' else 'fulfilled' end,updated_at=now() where id=${link.order_id}`;
  return result;
});
registerHandler(CommerceConfirmOfflineRefund,async(args)=>{
  const [r]=await args.tx<{amount_cents:number;provider:string;livemode:boolean;status:string;external_reference:string|null}[]>`select r.amount_cents,p.provider,p.livemode,r.status,r.external_reference
    from commerce_refunds r join commerce_payments p on p.id=r.payment_id where r.id=${args.input.refundId}`;
  if(!r||r.provider!=='offline')invalid('not_offline_refund');
  if(!['pending','succeeded'].includes(r.status))invalid('refund_not_pending');
  if(r.status==='succeeded'&&r.external_reference!==args.input.reference)invalid('refund_already_confirmed');
  if(r.status!=='succeeded')await lockOpenDay(args.tx,args.ctx);
  const result=await completeRefund({...args,input:{refundId:args.input.refundId,amountCents:r.amount_cents,status:'succeeded',
    stripeRefundId:null,stripeAccountId:null,livemode:r.livemode}});
  const [confirmed]=await args.tx<{id:string}[]>`update commerce_refunds set external_reference=${args.input.reference}
    where id=${args.input.refundId} and (external_reference is null or external_reference=${args.input.reference}) returning id`;
  if(!confirmed)invalid('refund_already_confirmed');
  return result;
});

registerHandler(CommerceClaimTask,async({input,ctx,tx,audit})=>{
  const [task]=await tx<{id:string;kind:string;subject_id:string}[]>`select id,kind,subject_id from commerce_tasks where location_id=${ctx.locationId}
    and (${input.taskId??null}::uuid is null or id=${input.taskId??null}) and ((status='pending' and retry_at<=now()) or (status='processing' and locked_until<now()))
    order by (kind in('expire_deposit','expire_deposit_request')) desc,created_at,id for update skip locked limit 1`;
  if(task)await tx`update commerce_tasks set status='processing',attempts=attempts+1,lease_id=${input.leaseId},locked_until=now()+interval '2 minutes' where id=${task.id}`;
  audit({entityType:'commerce_task',...(task?{entityId:task.id}:{}),after:{claimed:!!task}});
  return {task:task?{id:task.id,kind:task.kind,subjectId:task.subject_id,leaseId:input.leaseId}:null};
});
registerHandler(CommerceFinishTask,async({input,ctx,tx,audit})=>{
  const [task]=await tx<{id:string;kind:string;subject_id:string;attempts:number}[]>`select * from commerce_tasks where id=${input.taskId}
    and location_id=${ctx.locationId} and status='processing' and lease_id=${input.leaseId} for update`;
  if(task) {
    if(input.nextRunAfterSec&&!['reconcile','expire_checkout','membership_grant','payout_scan','payout_reconcile'].includes(task.kind))invalid('task_schedule_type_mismatch');
    if(input.session) {
      if(!['checkout','expire_checkout'].includes(task.kind))invalid('task_result_type_mismatch');
      await tx`update commerce_payments set checkout_session_id=${input.session.id},checkout_url=${input.session.url},checkout_expires_at=${input.session.expiresAt}::timestamptz
        where order_id=${task.subject_id} and (checkout_session_id is null or checkout_session_id=${input.session.id})`;
    }
    await tx`update commerce_tasks set status=${input.error?(task.attempts>=8?'review':'pending'):input.nextRunAfterSec?'pending':'done'},last_error=${input.error??null},
      attempts=${input.error?task.attempts:0},retry_at=now()+${input.error?Math.min(3600,2**task.attempts):input.nextRunAfterSec??0}::int*interval '1 second',lease_id=null,locked_until=null where id=${task.id}`;
  }
  audit({entityType:'commerce_task',entityId:input.taskId,after:{updated:!!task,error:input.error??null}});return {updated:!!task};
});
registerHandler(CommerceIssueAccess,async({input,ctx,tx,audit})=>{
  const [o]=await tx<{id:string}[]>`select id from commerce_orders where id=${input.orderId} and location_id=${ctx.locationId}`;
  if(!o)absent('commerce_order');
  const [t]=await tx<{expires_at:string}[]>`insert into commerce_access_tokens(org_id,location_id,order_id,token_hash,expires_at)
    values(${ctx.orgId},${ctx.locationId},${o.id},${input.tokenHash},now()+interval '7 days') returning expires_at::text`;
  audit({entityType:'commerce_order',entityId:o.id,after:{accessIssued:true}});return {expiresAt:t!.expires_at};
});
registerHandler(CommerceRetryTask,async({input,ctx,tx,audit})=>{
  const [task]=await tx<{id:string}[]>`update commerce_tasks set status='pending',attempts=0,last_error=null,retry_at=now(),lease_id=null,locked_until=null
    where id=${input.taskId} and location_id=${ctx.locationId} and status='review' returning id`;
  audit({entityType:'commerce_task',entityId:input.taskId,after:{retryRequested:!!task,reason:input.reason}});return {queued:!!task};
});
