import { createHash,createHmac,randomBytes,randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { beforeAll,afterAll,it,expect,vi } from 'vitest';
import type Stripe from 'stripe';
import { withTenant,closeDb } from '@gf/db';
import { AppError,httpStatusFor } from '@gf/contracts';
import { buildContext } from './actor';
import { dispatch } from './bus';
import { dispatchSystem } from './test/systemDispatch';
import { registerRawBodyParser } from './rawBody';
import { registerCommerceRoutes } from './commerce/routes';
import {registerStripeRoutes} from './stripe/routes';
import {registerMarketingRoutes} from './routes/marketing';
import {registerTicketsRoutes} from './routes/tickets';
import { metadataOf } from './commerce/provider';
import {reconcileCommerceOrder} from './commerce/reconciliation';
import {stripeClient} from './stripe/client';
import {saveVerifiedV2Account,newMerchantParams} from './commerce/accounts';
import {flushEmails} from './email/flush';
import {loadCommerceDay,dayBounds} from './queries/commerceDay';
import {loadDayMoney,resolveDate} from './handlers/dayclose';
import {loadDayClose} from './queries/money';
import './handlers/commerce';
import './handlers/billing';
import './handlers/marketing';
import './handlers/ticket';

const tenant={orgId:'22222222-2222-4222-8222-222222222222',locationId:'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',membershipId:null};
let ctx:Awaited<ReturnType<typeof buildContext>>;
let customerId:string,templateId:string;
const app=Fastify();
interface Order {orderId:string;status:string;paymentId:string;assetId:string;}
async function run<T=Order>(name:string,input:unknown,key=randomUUID()) {return (await dispatch<T>(name,input,ctx,{idempotencyKey:key})).result;}
async function offlineGift(businessKey=randomUUID()) {return run('commerce.createOrder',{kind:'gift_card',channel:'offline',businessKey,
  customerId,faceValueCents:10000,salePriceCents:8000,offlinePayment:{method:'cash',amountCents:8000,reference:'QA cash receipt'}});}
async function onlineGift(){return run('commerce.createOrder',{kind:'gift_card',channel:'online',businessKey:randomUUID(),customerId,templateId});}
beforeAll(async()=>{
  process.env.GF_CUSTOMER_COMMERCE_ENABLED='1';process.env.STRIPE_SECRET_KEY='sk_test_commerce_fixture';
  process.env.COMMERCE_STRIPE_MODE='test';process.env.STRIPE_COMMERCE_WEBHOOK_SECRET='whsec_commerce_fixture';
  process.env.STRIPE_COMMERCE_ACCOUNT_WEBHOOK_SECRET='whsec_commerce_account_fixture';
  process.env.STRIPE_WEBHOOK_SECRET='whsec_saas_fixture';
  const [m]=await withTenant(tenant,tx=>tx<{id:string;user_id:string}[]>`select m.id,m.user_id from memberships m
    join membership_roles mr on mr.membership_id=m.id join roles r on r.id=mr.role_id where m.location_id=${tenant.locationId} and r.key='owner' limit 1`);
  ctx=await buildContext({userId:m!.user_id,membershipId:m!.id});
  await dispatchSystem('billing.syncSubscription',{plan:'growth',subscriptionStatus:'active'},ctx);
  await run('commerce.saveSettings',{salesEnabled:true,depositsEnabled:false,membershipsEnabled:false});
  await dispatchSystem('commerce.saveAccount',{stripeAccountId:'acct_CommerceFixture',livemode:false,chargesEnabled:true,payoutsEnabled:true,
    detailsSubmitted:true,capabilities:{card_payments:'active'}},ctx,{idempotencyKey:randomUUID()});
  const [c]=await withTenant(tenant,tx=>tx<{id:string}[]>`select id from customers where org_id=${tenant.orgId} and merged_into_id is null limit 1`);customerId=c!.id;
  const t=await run<{templateId:string}>('giftcard.saveTemplate',{name:{en:'Commerce QA card'},faceValueCents:10000,salePriceCents:8000,onlineSale:true});templateId=t.templateId;
  registerRawBodyParser(app);registerCommerceRoutes(app,async()=>ctx);registerStripeRoutes(app,async()=>ctx);registerMarketingRoutes(app,async()=>ctx);
  registerTicketsRoutes(app,async()=>ctx);
  app.setErrorHandler((error,_,reply)=>reply.status(error instanceof AppError?httpStatusFor[error.code]:400).send({code:error instanceof AppError?error.code:'VALIDATION_FAILED'}));
  await app.ready();
});
afterAll(async()=>{await app.close();await closeDb();});
async function paidEvent(order:Order,over:Record<string,unknown>={}) {
  const event={id:`evt_${randomUUID()}`,object:'event',account:'acct_CommerceFixture',livemode:false,type:'checkout.session.completed',
    data:{object:{id:`cs_${order.orderId}`,object:'checkout.session',mode:'payment',payment_status:'paid',livemode:false,
      client_reference_id:order.orderId,metadata:metadataOf(ctx,order.orderId),payment_intent:`pi_${order.orderId}`,amount_total:8000,currency:'usd'}},...over} as unknown as Stripe.Event;
  return event;
}
async function signedWebhook(event:unknown,valid=true,url='/v1/stripe/commerce-webhook') {
  const payload=JSON.stringify(event),t=Math.floor(Date.now()/1000);
  const secret=url==='/v1/stripe/webhook'?'whsec_saas_fixture':url==='/v1/stripe/commerce-account-webhook'?'whsec_commerce_account_fixture':'whsec_commerce_fixture';
  const signature=createHmac('sha256',valid?secret:'wrong').update(`${t}.${payload}`).digest('hex');
  return app.inject({method:'POST',url,headers:{'content-type':'application/json','stripe-signature':`t=${t},v1=${signature}`},payload});
}
it('records real offline receipt facts separately from $100 face liability; duplicate issuance stays one',async()=>{
  const businessKey=randomUUID();const o=await offlineGift(businessKey);const replay=await offlineGift(businessKey);
  expect(o.status).toBe('fulfilled');expect(replay.orderId).toBe(o.orderId);
  const [r]=await withTenant(tenant,tx=>tx<{paid:number;face:number;balance:number}[]>`select p.amount_cents as paid,g.face_value_cents as face,g.balance_cents as balance
    from commerce_payments p join gift_cards g on g.purchase_order_id=p.order_id where p.order_id=${o.orderId}`);
  expect(r).toEqual({paid:8000,face:10000,balance:10000});
  const spent=await run<{remainingCents:number}>('giftcard.redeem',{giftCardId:o.assetId,dueCents:3000});expect(spent.remainingCents).toBe(7000);
});
it('blocks legacy issuance without explicit payment and applies financial roles to aliases',async()=>{
  await expect(run('giftcard.issue',{faceValueCents:10000,salePriceCents:8000})).rejects.toMatchObject({code:'VALIDATION_FAILED'});
  const base={businessKey:randomUUID(),channel:'offline',faceValueCents:10000,salePriceCents:8000};
  await expect(run('giftcard.issue',base)).rejects.toBeDefined();
  const proof={...base,offlinePayment:{method:'cash',amountCents:8000,reference:'Legacy QA receipt'}};
  const tech={...ctx,permissions:new Set(['ticket.write'] as const)};
  await expect(dispatch('giftcard.issue',proof,tech,{idempotencyKey:randomUUID()})).rejects.toMatchObject({code:'PERMISSION_DENIED'});
  await expect(run('giftcard.issue',{...proof,source:'online'})).rejects.toMatchObject({code:'VALIDATION_FAILED'});
  const issued=await run<{giftCardId:string}>('giftcard.issue',proof);
  const replay=await run<{giftCardId:string}>('giftcard.issue',proof);expect(replay.giftCardId).toBe(issued.giftCardId);
  const [fact]=await withTenant(tenant,tx=>tx<{paid:number}[]>`select p.amount_cents as paid from commerce_payments p join gift_cards g on g.purchase_order_id=p.order_id where g.id=${issued.giftCardId}`);
  expect(fact?.paid).toBe(8000);
  const gift={businessKey:randomUUID(),channel:'complimentary',faceValueCents:10000,salePriceCents:0,reason:'Gift for QA'};
  const desk={...ctx,permissions:new Set(['commerce.sell'] as const)};
  await expect(dispatch('giftcard.issue',gift,desk,{idempotencyKey:randomUUID()})).rejects.toMatchObject({code:'PERMISSION_DENIED'});
});
it('blocks technician asset-list, redemption, and prepaid checkout access at the server boundary',async()=>{
  const tech={...ctx,permissions:new Set(['ticket.read','ticket.write','customer.read'] as const)};
  for(const name of ['giftcard.redeem','package.redeem','marketing.redeemPackage']) {
    const input=name==='giftcard.redeem'?{giftCardId:randomUUID(),dueCents:100}:{packageId:randomUUID(),units:1};
    await expect(dispatch(name,input,tech,{idempotencyKey:randomUUID()})).rejects.toMatchObject({code:'PERMISSION_DENIED'});
  }
  await expect(dispatch('ticket.close',{ticketId:randomUUID(),payments:[{method:'gift_card',amountCents:100,giftCardId:randomUUID()}]},tech,
    {idempotencyKey:randomUUID()})).rejects.toMatchObject({code:'PERMISSION_DENIED'});
  const saved=ctx;ctx=tech;
  try {for(const url of ['/v1/desk/giftcards','/v1/desk/packages','/v1/desk/giftcards/verify?code=QA-invalid-credential','/v1/desk/commerce'])
    expect((await app.inject(url)).statusCode).toBe(403);
  } finally {ctx=saved;}
});
it('delivers a separate buyer receipt and recipient card without exposing the buyer order token or sale price',async()=>{
  const saved=process.env.BOOKING_BASE_URL;process.env.BOOKING_BASE_URL='http://localhost:5296';
  try {
    const input={kind:'gift_card',channel:'offline',businessKey:randomUUID(),faceValueCents:10000,salePriceCents:8000,
      customer:{name:'Commerce receipt QA',email:'commerce-buyer@example.test'},recipientEmail:'commerce-recipient@example.test',recipientNote:'<script>QA gift</script>',
      offlinePayment:{method:'cash',amountCents:8000,reference:'Notification QA receipt'}};
    const order=await run('commerce.createOrder',input);await run('commerce.createOrder',input);
    const messages=await withTenant(tenant,tx=>tx<{to_email:string;body_text:string;body_html:string;entity_type:string}[]>`
      select to_email,body_text,body_html,entity_type from email_outbox where entity_id=${order.orderId} order by entity_type`);
    expect(messages).toHaveLength(2);
    const buyer=messages.find(m=>m.to_email==='commerce-buyer@example.test');
    const recipient=messages.find(m=>m.to_email==='commerce-recipient@example.test');
    expect(!!buyer?.body_text.includes('#c/')).toBe(true);
    expect(!!recipient?.body_text.includes('#c/')).toBe(false);
    expect(!!recipient?.body_text.includes('80.00')).toBe(false);
    expect(!!recipient?.body_html.includes('<script>')).toBe(false);
    const [card]=await withTenant(tenant,tx=>tx<{code:string}[]>`select code from gift_cards where id=${order.assetId}`);
    expect(!!recipient?.body_text.includes(card!.code)).toBe(true);
  } finally {if(saved===undefined)delete process.env.BOOKING_BASE_URL;else process.env.BOOKING_BASE_URL=saved;}
});
it('disables and replaces lost credentials without duplicating value, revokes old access, and delivers only the current card',async()=>{
  const saved=process.env.BOOKING_BASE_URL;process.env.BOOKING_BASE_URL='http://localhost:5296';
  try{
    const order=await run('commerce.createOrder',{kind:'gift_card',channel:'offline',businessKey:randomUUID(),faceValueCents:10000,salePriceCents:8000,
      customer:{name:'Lost card QA',email:'commerce-loss-buyer@example.test'},recipientEmail:'commerce-loss-recipient@example.test',
      offlinePayment:{method:'cash',amountCents:8000,reference:'Lost card QA receipt'}});
    const [card]=await withTenant(tenant,tx=>tx<{code:string}[]>`select code from gift_cards where id=${order.assetId}`);
    await run('giftcard.redeem',{giftCardId:order.assetId,dueCents:3000});
    const [before]=await withTenant(tenant,tx=>tx`select count(*)::int as n,sum(amount_cents)::int as balance from customer_credit_ledger where subject_id=${order.assetId} and kind='gift_card'`);
    const disable={giftCardId:order.assetId,expectedVersion:1,reason:'Reported lost in QA'};
    const desk={...ctx,permissions:new Set(['commerce.sell'] as const)};
    await expect(dispatch('giftcard.disable',disable,desk,{idempotencyKey:randomUUID()})).rejects.toMatchObject({code:'PERMISSION_DENIED'});
    await run('giftcard.disable',disable);
    await expect(run('giftcard.redeem',{giftCardId:order.assetId,dueCents:100})).rejects.toMatchObject({code:'VALIDATION_FAILED',details:{reason:'gift_card_disabled'}});
    await expect(run('commerce.resendNotice',{orderId:order.orderId,reason:'Do not mail old credential'})).rejects.toMatchObject({code:'VALIDATION_FAILED'});
    const [tokens]=await withTenant(tenant,tx=>tx`select count(*)::int as n from commerce_access_tokens where order_id=${order.orderId} and revoked_at is null`);expect(tokens!.n).toBe(0);
    const payload={giftCardId:order.assetId,expectedVersion:1,reason:'Replacement QA'},key=randomUUID();
    const replacement=await run<{code:string;credentialVersion:number}>('giftcard.reissue',payload,key);
    const replay=await run<{code:string;credentialVersion:number}>('giftcard.reissue',payload,key);
    expect(replay.code===replacement.code).toBe(true);expect(replacement.credentialVersion).toBe(2);expect(replacement.code===card!.code).toBe(false);
    await expect(run('giftcard.reissue',payload)).rejects.toMatchObject({code:'VALIDATION_FAILED',details:{reason:'gift_credential_changed'}});
    await expect(run('giftcard.redeem',{code:card!.code,dueCents:100})).rejects.toMatchObject({code:'NOT_FOUND'});
    const [after]=await withTenant(tenant,tx=>tx`select count(*)::int as n,sum(amount_cents)::int as balance from customer_credit_ledger where subject_id=${order.assetId} and kind='gift_card'`);
    expect(after).toEqual(before);expect(after!.balance).toBe(7000);
    for(let n=0;n<10;n++)await flushEmails(tenant);
    const messages=await withTenant(tenant,tx=>tx<{status:string;entity_type:string;body_text:string;commerce_credential_version:number}[]>`
      select status,entity_type,body_text,commerce_credential_version from email_outbox where commerce_order_id=${order.orderId} order by created_at`);
    expect(messages.filter(m=>m.commerce_credential_version===1).every(m=>m.status==='failed')).toBe(true);
    const current=messages.filter(m=>m.commerce_credential_version===2);expect(current).toHaveLength(2);expect(current.every(m=>m.status==='captured')).toBe(true);
    const recipient=current.find(m=>m.entity_type.endsWith('_recipient'))!;expect(recipient.body_text.includes(replacement.code)).toBe(true);
    expect(recipient.body_text.includes('#c/')).toBe(false);expect(recipient.body_text.includes('80.00')).toBe(false);
    const resendKey=randomUUID();await run('commerce.resendNotice',{orderId:order.orderId,reason:'Delivery requested'},resendKey);
    await run('commerce.resendNotice',{orderId:order.orderId,reason:'Delivery requested'},resendKey);
    const [deliveries]=await withTenant(tenant,tx=>tx`select count(*)::int as n from email_outbox where commerce_order_id=${order.orderId} and entity_type like 'commerce_delivery_%'`);expect(deliveries!.n).toBe(2);
    const [loc]=await withTenant(tenant,tx=>tx<{slug:string}[]>`select slug from locations where id=${tenant.locationId}`);
    const lookup=await app.inject({method:'POST',url:`/v1/public/shops/${loc!.slug}/commerce/gift-balance`,payload:{code:replacement.code}});
    expect(lookup.statusCode).toBe(200);expect(lookup.json()).toMatchObject({balanceCents:7000,status:'active',currency:'USD'});
    expect(Object.keys(lookup.json()).sort()).toEqual(['balanceCents','currency','expiresAt','qr','status','timezone']);
    const oldLookup=await app.inject({method:'POST',url:`/v1/public/shops/${loc!.slug}/commerce/gift-balance`,payload:{code:card!.code}});expect(oldLookup.statusCode).toBe(404);
    const ledger=await app.inject({method:'GET',url:`/v1/desk/commerce/assets/gift_card/${order.assetId}`});expect(ledger.statusCode).toBe(200);
    expect(ledger.json().ledger).toHaveLength(before!.n);
  }finally{if(saved===undefined)delete process.env.BOOKING_BASE_URL;else process.env.BOOKING_BASE_URL=saved;}
});
it('rejects changed financial request under the same command key',async()=>{
  const key=randomUUID(),businessKey=randomUUID();
  const input={kind:'gift_card',channel:'offline',businessKey,customerId,faceValueCents:10000,salePriceCents:8000,offlinePayment:{method:'cash',amountCents:8000,reference:'receipt'}};
  await run('commerce.createOrder',input,key);
  await expect(run('commerce.createOrder',{...input,faceValueCents:11000},key)).rejects.toMatchObject({code:'IDEMPOTENCY_KEY_REUSED'});
});
it('never turns manually gifted face value into refundable purchase cash',async()=>{
  const order=await offlineGift();
  await run('giftcard.adjust',{giftCardId:order.assetId,amountCents:10000,reason:'Separate QA gift value'});
  await run('giftcard.redeem',{giftCardId:order.assetId,dueCents:10000});
  await expect(run('commerce.requestRefund',{paymentId:order.paymentId,amountCents:1,reason:'Cash cannot come from added gift value'}))
    .rejects.toMatchObject({code:'VALIDATION_FAILED',details:{reason:'gift_purchase_basis_requires_review'}});
  const result=await run<{remainingCents:number}>('giftcard.redeem',{giftCardId:order.assetId,dueCents:100});expect(result.remainingCents).toBe(9900);
});
it('accepts signed thin events through the complete server auth stack and keeps account administration protected',async()=>{
  // This case verifies the public signature boundary, with no JWT verification or remote Auth calls.
  process.env.SUPABASE_URL??='http://127.0.0.1:59999';
  const {buildServer}=await import('./server');
  const server=buildServer();
  try{
    const event={type:'v2.core.event_destination.ping',livemode:false},payload=JSON.stringify(event),t=Math.floor(Date.now()/1000);
    const signature=createHmac('sha256','whsec_commerce_account_fixture').update(`${t}.${payload}`).digest('hex');
    const response=await server.inject({method:'POST',url:'/v1/stripe/commerce-account-webhook',headers:{'content-type':'application/json','stripe-signature':`t=${t},v1=${signature}`},payload});
    expect(response.statusCode).toBe(200);expect(response.json().result).toBe('ignored_type');
    expect((await server.inject({method:'POST',url:'/v1/stripe/commerce-account-webhook',headers:{'content-type':'application/json'},payload})).statusCode).toBe(401);
    expect((await server.inject({method:'POST',url:'/v1/commerce/accounts/refresh',payload:{idempotencyKey:randomUUID()}})).statusCode).toBe(401);
  }finally{await server.close();}
});
it('never issues online assets until a signed paid fact, and deduplicates events and payments',async()=>{
  const o=await onlineGift();expect(o.assetId).toBeNull();const event=await paidEvent(o);
  expect((await signedWebhook(event,false)).statusCode).toBe(401);
  expect((await signedWebhook(event)).statusCode).toBe(200);
  expect((await signedWebhook(event)).statusCode).toBe(200);
  expect((await signedWebhook({...event,id:`evt_${randomUUID()}`})).statusCode).toBe(200);
  const [count]=await withTenant(tenant,tx=>tx<{n:number}[]>`select count(*)::int as n from gift_cards where purchase_order_id=${o.orderId}`);expect(count!.n).toBe(1);
});
it('rejects wrong connected account, mode and amount without granting credit',async()=>{
  const o=await onlineGift();
  for(const override of [{account:'acct_Unknown'},{livemode:true}])expect((await signedWebhook(await paidEvent(o,override))).statusCode).toBeGreaterThanOrEqual(400);
  const event=await paidEvent(o);(event.data.object as Stripe.Checkout.Session).amount_total=9000;
  expect((await signedWebhook(event)).statusCode).toBe(400);
  const [g]=await withTenant(tenant,tx=>tx`select asset_id from commerce_orders where id=${o.orderId}`);expect(g!.asset_id).toBeNull();
});
it('keeps unpaid Checkout returns pending',async()=>{
  const o=await onlineGift();const e=await paidEvent(o);(e.data.object as Stripe.Checkout.Session).payment_status='unpaid';
  expect((await signedWebhook(e)).json().result).toBe('awaiting_payment');
});
it('limits purchase refunds to unused paid value and freezes it against concurrent redemption',async()=>{
  const o=await offlineGift();await run('giftcard.redeem',{giftCardId:o.assetId,dueCents:3000});
  await expect(run('commerce.requestRefund',{paymentId:o.paymentId,amountCents:5601,reason:'QA refund'})).rejects.toMatchObject({code:'VALIDATION_FAILED'});
  const r=await run<{refundId:string}>('commerce.requestRefund',{paymentId:o.paymentId,amountCents:5600,reason:'QA refund'});
  await expect(run('giftcard.redeem',{giftCardId:o.assetId,dueCents:1})).rejects.toMatchObject({code:'VALIDATION_FAILED'});
  await run('commerce.confirmOfflineRefund',{refundId:r.refundId,reference:'cash returned receipt'});
  await expect(run('commerce.confirmOfflineRefund',{refundId:r.refundId,reference:'different receipt'})).rejects.toMatchObject({code:'VALIDATION_FAILED'});
  const [g]=await withTenant(tenant,tx=>tx`select balance_cents,reserved_cents from gift_cards where id=${o.assetId}`);
  expect(g).toMatchObject({balance_cents:0,reserved_cents:0});
  await run('commerce.confirmOfflineRefund',{refundId:r.refundId,reference:'cash returned receipt'});
  const [total]=await withTenant(tenant,tx=>tx<{n:number}[]>`select count(*)::int as n from customer_credit_ledger where subject_id=${o.assetId} and reason='purchase_refund'`);
  expect(total!.n).toBe(1);
});
it('restores reserved assets when Stripe refund fails and ignores a later payment replay after refund',async()=>{
  const o=await onlineGift(),e=await paidEvent(o);await signedWebhook(e);
  const r=await run<{refundId:string}>('commerce.requestRefund',{paymentId:o.paymentId,amountCents:8000,reason:'QA refund'});
  await dispatchSystem('commerce.completeRefund',{refundId:r.refundId,amountCents:8000,status:'failed',stripeRefundId:'re_failed',stripeAccountId:'acct_CommerceFixture',livemode:false},ctx,{idempotencyKey:randomUUID()});
  const r2=await run<{refundId:string}>('commerce.requestRefund',{paymentId:o.paymentId,amountCents:8000,reason:'QA refund again'});
  await dispatchSystem('commerce.completeRefund',{refundId:r2.refundId,amountCents:8000,status:'succeeded',stripeRefundId:'re_success',stripeAccountId:'acct_CommerceFixture',livemode:false},ctx,{idempotencyKey:randomUUID()});
  await signedWebhook({...e,id:`evt_${randomUUID()}`});
  const [order]=await withTenant(tenant,tx=>tx`select status from commerce_orders where id=${o.orderId}`);expect(order!.status).toBe('refunded');
});
it('records known-refund webhook receipts without double reversing value through duplicates and stale pending events',async()=>{
  const o=await onlineGift();await signedWebhook(await paidEvent(o));
  const r=await run<{refundId:string}>('commerce.requestRefund',{paymentId:o.paymentId,amountCents:8000,reason:'QA known refund'});
  const refundId=`re_${randomUUID()}`;
  const event=(status:string)=>({id:`evt_${randomUUID()}`,created:100,account:'acct_CommerceFixture',livemode:false,type:'refund.updated',
    data:{object:{id:refundId,object:'refund',payment_intent:`pi_${o.orderId}`,amount:8000,currency:'usd',status,metadata:{gf_refund_id:r.refundId}}}});
  const succeeded=event('succeeded');expect((await signedWebhook(succeeded)).statusCode).toBe(200);
  expect((await signedWebhook(succeeded)).statusCode).toBe(200);expect((await signedWebhook(event('pending'))).statusCode).toBe(200);
  const [fact]=await withTenant(tenant,tx=>tx`select r.status,
    (select count(*)::int from commerce_events where object_id=${refundId}) as events,
    (select count(*)::int from customer_credit_ledger where reason='purchase_refund' and meta->>'refundId'=r.id::text) as reversed
    from commerce_refunds r where r.id=${r.refundId}`);
  expect(fact).toEqual({status:'succeeded',events:2,reversed:1});
});
it('accepts a repeated signed refund whose receipt predates event-provenance metadata without changing its money',async()=>{
  const o=await onlineGift();await signedWebhook(await paidEvent(o));
  const r=await run<{refundId:string}>('commerce.requestRefund',{paymentId:o.paymentId,amountCents:8000,reason:'QA legacy receipt'});
  const id=`evt_${randomUUID()}`,refundId=`re_${randomUUID()}`,key=`commerce-event:acct_CommerceFixture:${id}`;
  const input={refundId:r.refundId,stripeRefundId:refundId,status:'succeeded',stripeAccountId:'acct_CommerceFixture',livemode:false,amountCents:8000};
  await dispatchSystem('commerce.completeRefund',input,ctx,{idempotencyKey:key});
  const event={id,created:100,account:'acct_CommerceFixture',livemode:false,type:'refund.updated',data:{object:{id:refundId,object:'refund',
    payment_intent:`pi_${o.orderId}`,amount:8000,currency:'usd',status:'succeeded',metadata:{gf_refund_id:r.refundId}}}};
  expect((await signedWebhook(event)).statusCode).toBe(200);
  await expect(dispatchSystem('commerce.completeRefund',{...input,amountCents:7999,event:{id,type:'refund.updated'}},ctx,{idempotencyKey:key}))
    .rejects.toMatchObject({code:'IDEMPOTENCY_KEY_REUSED'});
});
it('requires permissions, system origin and stable idempotency before financial changes',async()=>{
  const input={kind:'gift_card',channel:'complimentary',businessKey:randomUUID(),faceValueCents:10000,salePriceCents:0,reason:'QA gift'};
  await expect(dispatch('commerce.createOrder',input,{...ctx,permissions:new Set(['commerce.sell'])},{idempotencyKey:randomUUID()})).rejects.toMatchObject({code:'PERMISSION_DENIED'});
  await expect(dispatch('commerce.saveAccount',{},ctx)).rejects.toMatchObject({code:'PERMISSION_DENIED'});
  await expect(dispatch('commerce.createOrder',input,ctx)).rejects.toMatchObject({code:'VALIDATION_FAILED'});
});
it('isolates commerce rows by both location and organization',async()=>{
  const o=await offlineGift();
  const rows=await withTenant({...tenant,locationId:'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'},tx=>tx`select * from commerce_orders where id=${o.orderId}`);
  expect(rows).toHaveLength(0);
});
it('lets only one API instance claim a task and rejects an old lease result',async()=>{
  const o=await onlineGift();const [t]=await withTenant(tenant,tx=>tx<{id:string}[]>`select id from commerce_tasks where subject_id=${o.orderId} and kind='checkout'`);
  const leases=[randomUUID(),randomUUID()];
  const results=await Promise.all(leases.map(leaseId=>dispatchSystem<{task:{id:string;leaseId:string}|null}>('commerce.claimTask',{taskId:t!.id,leaseId},ctx,{idempotencyKey:randomUUID()})));
  expect(results.filter(r=>r.result.task)).toHaveLength(1);
  const old=await dispatchSystem<{updated:boolean}>('commerce.finishTask',{taskId:t!.id,leaseId:randomUUID()},ctx,{idempotencyKey:randomUUID()});expect(old.result.updated).toBe(false);
});
it('classifies historical package monetary issuance and quantity consumption without mixing units',async()=>{
  const rows=await withTenant(tenant,tx=>tx<{entry:string;unit:string}[]>`select entry,unit from customer_credit_ledger where kind='package'`);
  expect(rows.filter(r=>r.entry==='issue').every(r=>r.unit==='cents')).toBe(true);
  expect(rows.filter(r=>r.entry==='redeem').every(r=>r.unit==='sessions')).toBe(true);
});
async function sellPackage(sessions=10,priceCents=50000) {
  const [s]=await withTenant(tenant,tx=>tx<{id:string}[]>`select id from services where location_id=${tenant.locationId} and active order by sort,id limit 1`);
  const t=await run<{templateId:string}>('package.saveTemplate',{name:'QA package',priceCents,sessions,validDays:365,serviceIds:[s!.id],coverageMode:'any_included',commissionBasis:'sale_price'});
  const order=await run('commerce.createOrder',{kind:'package',channel:'offline',templateId:t.templateId,customerId,businessKey:randomUUID(),
    offlinePayment:{method:'cash',amountCents:priceCents,reference:'Package QA receipt'}});
  return {order,templateId:t.templateId,serviceId:s!.id};
}
it('publishes package terms and rejects an obsolete purchase quote before creating a customer or order',async()=>{
 const [service]=await withTenant(ctx,tx=>tx<{id:string}[]>`select id from services where active and location_id=${ctx.locationId} limit 1`);
 const product=await run<{templateId:string}>('package.saveTemplate',{name:{en:'Quoted online package'},priceCents:50000,sessions:10,serviceIds:[service!.id],validDays:365,onlineSale:true,coverageMode:'any_included',commissionBasis:'sale_price'});
 const [location]=await withTenant(ctx,tx=>tx<{slug:string}[]>`select slug from locations where id=${ctx.locationId}`);
 const catalog=await app.inject({method:'GET',url:`/v1/public/shops/${location!.slug}/commerce?locale=en`});expect(catalog.statusCode).toBe(200);expect(catalog.headers['cache-control']).toContain('no-store');
 const quote=catalog.json().packages.find((p:{id:string})=>p.id===product.templateId);expect(quote).toMatchObject({sessions:10,validDays:365,coverageMode:'any_included'});expect(quote.serviceNames).toHaveLength(1);expect(quote.quoteHash).toMatch(/^[a-f0-9]{64}$/);
 const before=await withTenant(ctx,tx=>tx`select (select count(*)::int from customers) as customers,(select count(*)::int from commerce_orders) as orders`);
 await run('package.saveTemplate',{templateId:product.templateId,name:{en:'Changed future catalog'},priceCents:75000,sessions:15,serviceIds:[service!.id],validDays:180,onlineSale:true,coverageMode:'any_included',commissionBasis:'sale_price'});
 await expect(dispatchSystem('commerce.publicOrder',{kind:'package',channel:'online',templateId:product.templateId,businessKey:randomUUID(),expectedQuoteHash:quote.quoteHash,customer:{name:'Quote QA',email:'quote@example.test'}},{...ctx,membershipId:null},{idempotencyKey:randomUUID()})).rejects.toMatchObject({details:{reason:'commerce_purchase_quote_changed'}});
 expect(await withTenant(ctx,tx=>tx`select (select count(*)::int from customers) as customers,(select count(*)::int from commerce_orders) as orders`)).toEqual(before);
});
it('preserves package purchase rules and price after catalog changes and refunds exactly unused value',async()=>{
  const {order,templateId,serviceId}=await sellPackage();
  await run('package.redeem',{packageId:order.assetId,customerId,units:1});
  await run('package.saveTemplate',{templateId,name:'Changed catalog',priceCents:99000,sessions:2,serviceIds:[],validDays:7,coverageMode:'bundle',commissionBasis:'zero'});
  const [p]=await withTenant(tenant,tx=>tx`select remaining_sessions,purchase_snapshot from customer_packages where id=${order.assetId}`);
  expect(p!.remaining_sessions).toBe(9);expect(p!.purchase_snapshot).toMatchObject({amountCents:50000,sessions:10,serviceIds:[serviceId],validDays:365,coverageMode:'any_included',commissionBasis:'sale_price'});
  const [staff]=await withTenant(ctx,tx=>tx<{membership_id:string}[]>`select membership_id from staff_profiles where location_id=${ctx.locationId} and is_bookable limit 1`);
  const ticket=await run<{ticketId:string}>('ticket.open',{customerId,items:[{serviceId,membershipId:staff!.membership_id}]});
  const view=await app.inject({method:'GET',url:'/v1/desk/tickets'});expect(view.statusCode).toBe(200);
  const available=view.json().tickets.find((t:{ticketId:string})=>t.ticketId===ticket.ticketId).availablePackages.find((p:{customerPackageId:string})=>p.customerPackageId===order.assetId);
  expect(available).toMatchObject({name:'QA package',serviceIds:[serviceId],remainingSessions:9,totalSessions:10,coverageMode:'any_included'});
  await expect(run('commerce.requestRefund',{paymentId:order.paymentId,amountCents:45001,reason:'Unused package'})).rejects.toMatchObject({code:'VALIDATION_FAILED'});
  const r=await run<{refundId:string}>('commerce.requestRefund',{paymentId:order.paymentId,amountCents:45000,reason:'Unused package'});
  await expect(run('package.redeem',{packageId:order.assetId,customerId,units:1})).rejects.toMatchObject({code:'VALIDATION_FAILED'});
  await run('commerce.confirmOfflineRefund',{refundId:r.refundId,reference:'Returned unused package value'});
  const [ledger]=await withTenant(tenant,tx=>tx<{balance:number;value:number}[]>`select sum(quantity)::int as balance,sum(value_cents)::int as value from customer_package_ledger where package_id=${order.assetId}`);
  expect(ledger!.balance).toBe(0);expect(ledger!.value).toBe(0);
  const token=randomBytes(32).toString('base64url');await dispatchSystem('commerce.issueAccess',{orderId:order.orderId,tokenHash:createHash('sha256').update(token).digest('hex')},ctx,{idempotencyKey:randomUUID()});
  const [location]=await withTenant(ctx,tx=>tx<{slug:string}[]>`select slug from locations where id=${ctx.locationId}`);
  const purchase=await app.inject({method:'GET',url:`/v1/public/shops/${location!.slug}/commerce/orders/${order.orderId}`,headers:{'x-gf-commerce-token':token}});
  expect(purchase.statusCode).toBe(200);expect(purchase.json()).toMatchObject({refundedCents:45000,pendingRefundCents:0,asset:{remaining_sessions:0}});
});
it('conserves original cents and quantities through package consume, purchase refund, restore and reconsume',async()=>{
  const {order}=await sellPackage(10,50003);
  await run('package.redeem',{packageId:order.assetId,customerId,units:1});
  const [first]=await withTenant(tenant,tx=>tx<{id:string}[]>`select id from customer_package_ledger where package_id=${order.assetId} and entry='redeem' order by seq limit 1`);
  await run('package.redeem',{packageId:order.assetId,customerId,units:2});
  const r=await run<{refundId:string}>('commerce.requestRefund',{paymentId:order.paymentId,amountCents:5001,reason:'Unused unit'});
  await run('commerce.confirmOfflineRefund',{refundId:r.refundId,reference:'Unused unit returned'});
  await run('package.restore',{redemptionId:first!.id,reason:'Undo original manual consumption'});
  await run('package.redeem',{packageId:order.assetId,customerId,units:7});
  await run('package.restore',{redemptionId:first!.id,reason:'Undo original manual consumption'});
  const [totals]=await withTenant(tenant,tx=>tx`select sum(quantity)::int as quantity,sum(value_cents)::int as value from customer_package_ledger where package_id=${order.assetId}`);
  expect(totals).toMatchObject({quantity:0,value:0});
  const [asset]=await withTenant(tenant,tx=>tx`select remaining_sessions,available_units from customer_packages where id=${order.assetId}`);
  expect(asset).toMatchObject({remaining_sessions:0,available_units:'{}'});
});
it('never restores historical unidentified or financially frozen package redemptions',async()=>{
  const {order}=await sellPackage();await run('package.redeem',{packageId:order.assetId,customerId,units:1});
  const [first]=await withTenant(tenant,tx=>tx<{id:string}[]>`select id from customer_package_ledger where package_id=${order.assetId} and entry='redeem'`);
  const r=await run<{refundId:string}>('commerce.requestRefund',{paymentId:order.paymentId,amountCents:5000,reason:'Unused unit refund'});
  await expect(run('package.restore',{redemptionId:first!.id,reason:'Attempt during reservation'})).rejects.toMatchObject({code:'VALIDATION_FAILED'});
  await dispatchSystem('commerce.completeRefund',{refundId:r.refundId,stripeRefundId:null,status:'failed',stripeAccountId:null,livemode:false,amountCents:5000},ctx,{idempotencyKey:randomUUID()});
  await run('package.restore',{redemptionId:first!.id,reason:'Correct original consumption'});
  const [asset]=await withTenant(tenant,tx=>tx`select remaining_sessions,available_units from customer_packages where id=${order.assetId}`);
  expect(asset).toMatchObject({remaining_sessions:10,available_units:'{[0,10)}'});
  const [historical]=await withTenant(tenant,tx=>tx<{id:string}[]>`insert into customer_package_ledger(org_id,location_id,package_id,entry,quantity,value_cents,reference)
    values(${tenant.orgId},${tenant.locationId},${order.assetId},'redeem',-1,-5000,${`legacy-proof-missing:${randomUUID()}`}) returning id`);
  await expect(run('package.restore',{redemptionId:historical!.id,reason:'Unidentified original units'})).rejects.toMatchObject({details:{reason:'historical_redemption_requires_review'}});
});
it('serializes two desks consuming the last package session',async()=>{
  const {order}=await sellPackage(1);
  const results=await Promise.allSettled([run('package.redeem',{packageId:order.assetId,customerId,units:1}),run('marketing.redeemPackage',{packageId:order.assetId,customerId,units:1})]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  const [p]=await withTenant(tenant,tx=>tx`select remaining_sessions from customer_packages where id=${order.assetId}`);expect(p!.remaining_sessions).toBe(0);
});
it('treats unlimited as a dated entitlement and caps manual purchase refund at actual money received',async()=>{
  const day=await withTenant(ctx,tx=>resolveDate(tx,ctx.locationId)),beforeDay=(await withTenant(ctx,tx=>loadCommerceDay(tx,ctx.locationId,day))).currencies.find(c=>c.currency==='usd')!;
  const {order}=await sellPackage(0);
  const before=await app.inject({method:'GET',url:'/v1/desk/packages'});expect(before.statusCode).toBe(200);
  expect(before.json().userPackages.find((p:{id:string})=>p.id===order.assetId)).toMatchObject({totalUnits:0,remainingUnits:0,canRedeem:true});
  await run('package.redeem',{packageId:order.assetId,customerId,units:100});
  const usedDay=(await withTenant(ctx,tx=>loadCommerceDay(tx,ctx.locationId,day))).currencies.find(c=>c.currency==='usd')!;expect(usedDay.packageUnitsRemaining).toBe(beforeDay.packageUnitsRemaining);expect(usedDay.unlimitedPackageCount-beforeDay.unlimitedPackageCount).toBe(1);
  await expect(run('commerce.requestRefund',{paymentId:order.paymentId,amountCents:50001,reason:'Terminate unlimited'})).rejects.toMatchObject({code:'VALIDATION_FAILED'});
  await expect(run('commerce.requestRefund',{paymentId:order.paymentId,amountCents:20000,reason:'Terminate unlimited'})).rejects.toMatchObject({details:{reason:'unlimited_refund_requires_termination_confirmation'}});
  const refund=await run<{refundId:string}>('commerce.requestRefund',{paymentId:order.paymentId,amountCents:20000,reason:'Terminate unlimited',unlimitedTerminationConfirmed:true});
  const frozen=await app.inject({method:'GET',url:'/v1/desk/packages'});expect(frozen.json().userPackages.find((p:{id:string})=>p.id===order.assetId).canRedeem).toBe(false);
  await expect(run('package.redeem',{packageId:order.assetId,customerId,units:1})).rejects.toMatchObject({code:'VALIDATION_FAILED'});
  await run('commerce.confirmOfflineRefund',{refundId:refund.refundId,reference:'Returned unlimited payment'});
  const [p]=await withTenant(tenant,tx=>tx`select status,remaining_sessions from customer_packages where id=${order.assetId}`);expect(p).toMatchObject({status:'void',remaining_sessions:0});
  const endedDay=(await withTenant(ctx,tx=>loadCommerceDay(tx,ctx.locationId,day))).currencies.find(c=>c.currency==='usd')!;expect(endedDay.packageUnitsRemaining).toBe(beforeDay.packageUnitsRemaining);expect(endedDay.unlimitedPackageCount).toBe(beforeDay.unlimitedPackageCount);
});
it('routes disputes without metadata by account/payment, freezes remaining value, and keeps terminal results through stale events',async()=>{
  const order=await onlineGift();await signedWebhook(await paidEvent(order));
  const [asset]=await withTenant(tenant,tx=>tx<{asset_id:string}[]>`select asset_id from commerce_orders where id=${order.orderId}`);
  await run('giftcard.redeem',{giftCardId:asset!.asset_id,dueCents:3000});
  const externalId=`du_${randomUUID()}`;
  const event=(status:string,created:number)=>({id:`evt_${randomUUID()}`,created,account:'acct_CommerceFixture',livemode:false,type:'charge.dispute.updated',
    data:{object:{id:externalId,object:'dispute',livemode:false,payment_intent:`pi_${order.orderId}`,amount:8000,currency:'usd',status,metadata:{}}}} as unknown as Stripe.Event);
  const opened=event('needs_response',100);
  expect((await signedWebhook(opened)).statusCode).toBe(200);expect((await signedWebhook(opened)).statusCode).toBe(200);
  await expect(run('giftcard.redeem',{giftCardId:asset!.asset_id,dueCents:1})).rejects.toMatchObject({details:{reason:'gift_card_under_review'}});
  await expect(run('commerce.requestRefund',{paymentId:order.paymentId,amountCents:100,reason:'Refund QA'})).rejects.toMatchObject({code:'VALIDATION_FAILED'});
  const [before]=await withTenant(tenant,tx=>tx`select balance_cents,commerce_frozen from gift_cards where id=${asset!.asset_id}`);
  expect(before).toMatchObject({balance_cents:7000,commerce_frozen:true});
  expect((await signedWebhook(event('won',200))).statusCode).toBe(200);
  expect((await signedWebhook(event('under_review',150))).statusCode).toBe(200);
  const [after]=await withTenant(tenant,tx=>tx`select g.balance_cents,g.commerce_frozen,p.status from gift_cards g join commerce_payments p on p.order_id=g.purchase_order_id where g.id=${asset!.asset_id}`);
  expect(after).toMatchObject({balance_cents:7000,commerce_frozen:false,status:'paid'});
  const [reviews]=await withTenant(tenant,tx=>tx`select count(*)::int as n from commerce_review_items where payment_id=${order.paymentId}`);expect(reviews!.n).toBe(1);
});
it('captures Dashboard refunds with no commerce metadata and prevents spending or another purchase refund',async()=>{
  const order=await onlineGift();await signedWebhook(await paidEvent(order));
  const [asset]=await withTenant(tenant,tx=>tx<{asset_id:string}[]>`select asset_id from commerce_orders where id=${order.orderId}`);
  const event={id:`evt_${randomUUID()}`,created:100,account:'acct_CommerceFixture',livemode:false,type:'refund.created',
    data:{object:{id:`re_external_${randomUUID()}`,object:'refund',payment_intent:`pi_${order.orderId}`,amount:8000,currency:'usd',status:'succeeded',metadata:{}}}} as unknown as Stripe.Event;
  expect((await signedWebhook(event)).statusCode).toBe(200);
  expect((await signedWebhook(event)).statusCode).toBe(200);
  await expect(run('giftcard.redeem',{giftCardId:asset!.asset_id,dueCents:1})).rejects.toMatchObject({code:'VALIDATION_FAILED'});
  await expect(run('commerce.requestRefund',{paymentId:order.paymentId,amountCents:8000,reason:'Refund QA'})).rejects.toMatchObject({code:'VALIDATION_FAILED'});
  const response=await app.inject('/v1/desk/commerce');expect(response.statusCode).toBe(200);
  expect(response.json().reviewItems.some((r:{payment_id:string;status:string})=>r.payment_id===order.paymentId&&r.status==='review')).toBe(true);
  const [state]=await withTenant(tenant,tx=>tx`select o.status,g.balance_cents,g.commerce_frozen from commerce_orders o join gift_cards g on g.id=o.asset_id where o.id=${order.orderId}`);
  expect(state).toMatchObject({status:'review',balance_cents:10000,commerce_frozen:true});
  const [review]=await withTenant(tenant,tx=>tx<{id:string}[]>`select id from commerce_review_items where payment_id=${order.paymentId}`);
  const applied=await run<{refundId:string}>('commerce.applyExternalRefund',{reviewId:review!.id,reason:'Apply confirmed Dashboard refund'});
  await run('commerce.applyExternalRefund',{reviewId:review!.id,reason:'Apply confirmed Dashboard refund'});
  const [settled]=await withTenant(tenant,tx=>tx`select o.status,g.balance_cents,g.commerce_frozen,
    (select count(*)::int from commerce_tasks where kind='refund' and subject_id=${applied.refundId}) as tasks
    from commerce_orders o join gift_cards g on g.id=o.asset_id where o.id=${order.orderId}`);
  expect(settled).toMatchObject({status:'refunded',balance_cents:0,commerce_frozen:false,tasks:0});
  expect((await signedWebhook(await paidEvent(order))).statusCode).toBe(200);
  const [after]=await withTenant(tenant,tx=>tx`select balance_cents from gift_cards where id=${asset!.asset_id}`);expect(after!.balance_cents).toBe(0);
});
it('retains review when an external refund exceeds the value still available to reverse',async()=>{
  const order=await onlineGift();await signedWebhook(await paidEvent(order));
  const [asset]=await withTenant(tenant,tx=>tx<{asset_id:string}[]>`select asset_id from commerce_orders where id=${order.orderId}`);
  await run('giftcard.redeem',{giftCardId:asset!.asset_id,dueCents:7000});
  const event={id:`evt_${randomUUID()}`,created:100,account:'acct_CommerceFixture',livemode:false,type:'refund.created',
    data:{object:{id:`re_external_${randomUUID()}`,object:'refund',payment_intent:`pi_${order.orderId}`,amount:8000,currency:'usd',status:'succeeded'}}} as unknown as Stripe.Event;
  expect((await signedWebhook(event)).statusCode).toBe(200);
  const [review]=await withTenant(tenant,tx=>tx<{id:string}[]>`select id from commerce_review_items where payment_id=${order.paymentId}`);
  await expect(run('commerce.applyExternalRefund',{reviewId:review!.id,reason:'Attempt to reverse used value'})).rejects.toMatchObject({code:'VALIDATION_FAILED'});
  const [state]=await withTenant(tenant,tx=>tx`select balance_cents,commerce_frozen from gift_cards where id=${asset!.asset_id}`);
  expect(state).toMatchObject({balance_cents:3000,commerce_frozen:true});
  const [refunds]=await withTenant(tenant,tx=>tx`select count(*)::int as n from commerce_refunds where payment_id=${order.paymentId}`);expect(refunds!.n).toBe(0);
});
it('does not issue assets when a verified dispute precedes Checkout payment; won resolution fulfills once',async()=>{
  const order=await onlineGift();const externalId=`du_${randomUUID()}`;
  const fact={orderId:order.orderId,paymentIntentId:`pi_${order.orderId}`,stripeAccountId:'acct_CommerceFixture',livemode:false,
    kind:'dispute',externalId,amountCents:8000,currency:'usd',providerStatus:'needs_response',eventId:`evt_${randomUUID()}`,eventType:'charge.dispute.created',eventCreated:100};
  await dispatchSystem('commerce.recordRisk',fact,ctx,{idempotencyKey:randomUUID()});
  expect((await signedWebhook(await paidEvent(order))).statusCode).toBe(200);
  const [held]=await withTenant(tenant,tx=>tx`select asset_id,status from commerce_orders where id=${order.orderId}`);expect(held).toMatchObject({asset_id:null,status:'review'});
  const won={...fact,providerStatus:'won',eventId:`evt_${randomUUID()}`,eventCreated:200};
  await dispatchSystem('commerce.recordRisk',won,ctx,{idempotencyKey:randomUUID()});await dispatchSystem('commerce.recordRisk',won,ctx,{idempotencyKey:randomUUID()});
  const [fulfilled]=await withTenant(tenant,tx=>tx`select status,(select count(*)::int from gift_cards where purchase_order_id=o.id) as cards from commerce_orders o where id=${order.orderId}`);
  expect(fulfilled).toMatchObject({status:'fulfilled',cards:1});
});
it('records verified balance facts in their settlement currency and rejects changed or cross-account financial facts',async()=>{
  const order=await onlineGift();await signedWebhook(await paidEvent(order));
  const fact={target:'payment',id:order.paymentId,stripeAccountId:'acct_CommerceFixture',livemode:false,providerId:`ch_${order.orderId}`,
    originalAmountCents:8000,balanceTransactionId:`txn_${order.orderId}`,currency:'usd',grossCents:8000,feeCents:262,netCents:7738,
    occurredAt:'2026-09-30T14:00:00.000Z',availableOn:'2026-10-02T00:00:00.000Z'};
  await expect(dispatchSystem('commerce.recordSettlement',{...fact,netCents:7739},ctx,{idempotencyKey:randomUUID()})).rejects.toMatchObject({code:'VALIDATION_FAILED'});
  await expect(dispatchSystem('commerce.recordSettlement',{...fact,stripeAccountId:'acct_other'},ctx,{idempotencyKey:randomUUID()})).rejects.toMatchObject({code:'VALIDATION_FAILED'});
  await dispatchSystem('commerce.recordSettlement',fact,ctx,{idempotencyKey:randomUUID()});
  await expect(dispatchSystem('commerce.recordSettlement',{...fact,feeCents:263,netCents:7737},ctx,{idempotencyKey:randomUUID()})).rejects.toMatchObject({code:'VALIDATION_FAILED'});
  const [p]=await withTenant(tenant,tx=>tx`select settlement_currency,settlement_gross_cents,fee_cents,net_cents,paid_at::text from commerce_payments where id=${order.paymentId}`);
  expect(p).toMatchObject({settlement_currency:'usd',settlement_gross_cents:8000,fee_cents:262,net_cents:7738});expect(Date.parse(p!.paid_at)).toBe(Date.parse(fact.occurredAt));
});
it('reconciles a missed paid webhook only after inspecting a pre-existing provider refund (failure injection, not Stripe sandbox)',async()=>{
  const order=await onlineGift(),sessionId=`cs_${order.orderId}`,intentId=`pi_${order.orderId}`;
  const [task]=await withTenant(tenant,tx=>tx<{id:string}[]>`select id from commerce_tasks where subject_id=${order.orderId} and kind='checkout'`);
  const leaseId=randomUUID();await dispatchSystem('commerce.claimTask',{taskId:task!.id,leaseId},ctx,{idempotencyKey:randomUUID()});
  await dispatchSystem('commerce.finishTask',{taskId:task!.id,leaseId,session:{id:sessionId,url:'https://checkout.stripe.test/fixture',expiresAt:'2026-10-01T00:00:00.000Z'}},ctx,{idempotencyKey:randomUUID()});
  const metadata=metadataOf(ctx,order.orderId),sdk=stripeClient();
  const session={id:sessionId,mode:'payment',status:'complete',payment_status:'paid',livemode:false,client_reference_id:order.orderId,
    payment_intent:intentId,amount_total:8000,currency:'usd',metadata} as unknown as Stripe.Checkout.Session;
  const balance={id:`txn_${order.orderId}`,amount:8000,currency:'usd',fee:262,net:7738,created:1790784000,available_on:1790956800};
  const intent={id:intentId,status:'succeeded',livemode:false,amount_received:8000,currency:'usd',metadata,
    latest_charge:{id:`ch_${order.orderId}`,livemode:false,payment_intent:intentId,amount:8000,created:1790784000,balance_transaction:balance}} as unknown as Stripe.PaymentIntent;
  const refund={id:`re_${order.orderId}`,object:'refund',payment_intent:intentId,status:'succeeded',amount:8000,currency:'usd',created:1790785000} as Stripe.Refund;
  async function* list<T>(rows:T[]){yield* rows;}
  const getSession=vi.spyOn(sdk.checkout.sessions,'retrieve').mockResolvedValue(session as any);
  const getIntent=vi.spyOn(sdk.paymentIntents,'retrieve').mockResolvedValue(intent as any);
  const refunds=vi.spyOn(sdk.refunds,'list').mockImplementation(()=>list([refund]) as any);
  const disputes=vi.spyOn(sdk.disputes,'list').mockImplementation(()=>list([]) as any);
  try {
    expect(await reconcileCommerceOrder(ctx,order.orderId)).toBe(3600);
    const [state]=await withTenant(tenant,tx=>tx`select o.status,o.asset_id,p.status as payment_status,p.net_cents from commerce_orders o join commerce_payments p on p.order_id=o.id where o.id=${order.orderId}`);
    expect(state).toMatchObject({status:'review',asset_id:null,payment_status:'paid',net_cents:7738});
    expect(getSession).toHaveBeenCalledWith(sessionId,{}, {stripeAccount:'acct_CommerceFixture'});
    expect(refunds).toHaveBeenCalledWith({payment_intent:intentId,limit:100},{stripeAccount:'acct_CommerceFixture'});
    const observations=await withTenant(tenant,tx=>tx<{event_id:string}[]>`select event_id from commerce_events where object_id=${refund.id}`);
    expect(observations.length).toBeGreaterThan(0);expect(observations.every(e=>e.event_id.startsWith('reconcile:'))).toBe(true);
    const [review]=await withTenant(tenant,tx=>tx<{id:string}[]>`select id from commerce_review_items where payment_id=${order.paymentId}`);
    await run('commerce.applyExternalRefund',{reviewId:review!.id,reason:'Reverse confirmed refund before fulfillment'});
    const [after]=await withTenant(tenant,tx=>tx`select status,asset_id from commerce_orders where id=${order.orderId}`);expect(after).toMatchObject({status:'refunded',asset_id:null});
  } finally {getSession.mockRestore();getIntent.mockRestore();refunds.mockRestore();disputes.mockRestore();}
});
it('recovers a valid late paid fact after an expired Checkout without issuing twice',async()=>{
  const order=await onlineGift(),sessionId=`cs_${order.orderId}`;
  const [task]=await withTenant(tenant,tx=>tx<{id:string}[]>`select id from commerce_tasks where subject_id=${order.orderId} and kind='checkout'`);
  const leaseId=randomUUID();await dispatchSystem('commerce.claimTask',{taskId:task!.id,leaseId},ctx,{idempotencyKey:randomUUID()});
  await dispatchSystem('commerce.finishTask',{taskId:task!.id,leaseId,session:{id:sessionId,url:'https://checkout.stripe.test/fixture',expiresAt:'2026-10-01T00:00:00.000Z'}},ctx,{idempotencyKey:randomUUID()});
  await dispatchSystem('commerce.expireOrder',{orderId:order.orderId,sessionId,stripeAccountId:'acct_CommerceFixture',livemode:false},ctx,{idempotencyKey:randomUUID()});
  const [expired]=await withTenant(tenant,tx=>tx`select status,asset_id from commerce_orders where id=${order.orderId}`);expect(expired).toMatchObject({status:'canceled',asset_id:null});
  expect((await signedWebhook(await paidEvent(order))).statusCode).toBe(200);expect((await signedWebhook(await paidEvent(order))).statusCode).toBe(200);
  const [paid]=await withTenant(tenant,tx=>tx`select status,(select count(*)::int from gift_cards where purchase_order_id=o.id) as cards from commerce_orders o where id=${order.orderId}`);
  expect(paid).toMatchObject({status:'fulfilled',cards:1});
});
it('reschedules reconciliation under its lease and keeps operator retries permissioned',async()=>{
  const order=await onlineGift();
  await withTenant(tenant,tx=>tx`update commerce_tasks set retry_at=now()-interval '1 minute' where subject_id=${order.orderId} and kind='reconcile'`);
  const [task]=await withTenant(tenant,tx=>tx<{id:string}[]>`select id from commerce_tasks where subject_id=${order.orderId} and kind='reconcile'`);
  const leaseId=randomUUID();await dispatchSystem('commerce.claimTask',{taskId:task!.id,leaseId},ctx,{idempotencyKey:randomUUID()});
  await dispatchSystem('commerce.finishTask',{taskId:task!.id,leaseId,nextRunAfterSec:3600},ctx,{idempotencyKey:randomUUID()});
  const [scheduled]=await withTenant(tenant,tx=>tx`select status,attempts,lease_id,retry_at>now()+interval '59 minutes' as deferred from commerce_tasks where id=${task!.id}`);
  expect(scheduled).toMatchObject({status:'pending',attempts:0,lease_id:null,deferred:true});
  await withTenant(tenant,tx=>tx`update commerce_tasks set status='review',attempts=8,last_error='fixture_failure' where id=${task!.id}`);
  const desk={...ctx,permissions:new Set(['commerce.sell'] as const)};
  await expect(dispatch('commerce.retryTask',{taskId:task!.id,reason:'Retry after repair'},desk,{idempotencyKey:randomUUID()})).rejects.toMatchObject({code:'PERMISSION_DENIED'});
  expect(await run('commerce.retryTask',{taskId:task!.id,reason:'Retry after repair'})).toMatchObject({queued:true});
});
it('retains existing v1 onboarding and uses verified v2 capabilities and thin events without crossing modes',async()=>{
  process.env.APP_BASE_URL='http://localhost:5297';
  const sdk=stripeClient();
  const v1=vi.spyOn(sdk.accounts,'retrieve').mockResolvedValue({id:'acct_CommerceFixture',charges_enabled:true,payouts_enabled:true,details_submitted:true,capabilities:{card_payments:'active'}} as any);
  const oldLink=vi.spyOn(sdk.accountLinks,'create').mockResolvedValue({url:'https://connect.stripe.com/setup/fixture'} as any);
  const createV2=vi.spyOn(sdk.v2.core.accounts,'create');
  const params=newMerchantParams(ctx);expect(params.defaults?.responsibilities).toEqual({fees_collector:'stripe',losses_collector:'stripe'});
  expect(params.configuration?.customer).toBeUndefined();expect(params.identity?.attestations).toBeUndefined();
  const inactive={id:'acct_CommerceFixture',object:'v2.core.account',livemode:false,configuration:{merchant:{capabilities:{card_payments:{status:'inactive'}}}}} as unknown as Stripe.V2.Core.Account;
  const active={...inactive,configuration:{merchant:{capabilities:{card_payments:{status:'active'},stripe_balance:{payouts:{status:'active'}}}}}} as unknown as Stripe.V2.Core.Account;
  const getV2=vi.spyOn(sdk.v2.core.accounts,'retrieve').mockResolvedValue(active as any);
  const newLink=vi.spyOn(sdk.v2.core.accountLinks,'create').mockResolvedValue({url:'https://connect.stripe.com/setup/fixture-v2'} as any);
  try {
    expect((await app.inject({method:'POST',url:'/v1/commerce/accounts/onboard',payload:{idempotencyKey:randomUUID()}})).statusCode).toBe(200);
    expect(v1).toHaveBeenCalled();expect(oldLink).toHaveBeenCalled();expect(createV2).not.toHaveBeenCalled();
    await expect(saveVerifiedV2Account(ctx,{...active,livemode:true},false,randomUUID())).rejects.toMatchObject({code:'VALIDATION_FAILED'});
    await saveVerifiedV2Account(ctx,inactive,false,randomUUID());
    await expect(onlineGift()).rejects.toMatchObject({code:'VALIDATION_FAILED'});
    const [unready]=await withTenant(tenant,tx=>tx`select api_version,charges_enabled,details_submitted from commerce_accounts where location_id=${tenant.locationId}`);
    expect(unready).toMatchObject({api_version:'v2',charges_enabled:false,details_submitted:false});
    const event={id:`evt_${randomUUID()}`,object:'v2.core.event',livemode:false,type:'v2.core.account[configuration.merchant].capability_status_updated',
      related_object:{id:'acct_CommerceFixture',type:'v2.core.account'}};
    expect((await signedWebhook(event,false,'/v1/stripe/commerce-account-webhook')).statusCode).toBe(401);
    expect((await signedWebhook({...event,livemode:true},true,'/v1/stripe/commerce-account-webhook')).statusCode).toBe(400);
    expect((await signedWebhook(event,true,'/v1/stripe/commerce-account-webhook')).statusCode).toBe(200);
    expect((await signedWebhook(event,true,'/v1/stripe/commerce-account-webhook')).statusCode).toBe(200);
    const [ready]=await withTenant(tenant,tx=>tx`select charges_enabled,payouts_enabled from commerce_accounts where location_id=${tenant.locationId}`);
    expect(ready).toMatchObject({charges_enabled:true,payouts_enabled:true});
    const [count]=await withTenant(tenant,tx=>tx`select count(*)::int as n from commerce_events where event_id=${`${event.id}:${tenant.locationId}`}`);expect(count!.n).toBe(1);
    expect((await app.inject({method:'POST',url:'/v1/commerce/accounts/onboard',payload:{idempotencyKey:randomUUID()}})).statusCode).toBe(200);
    expect(newLink).toHaveBeenCalledWith(expect.objectContaining({account:'acct_CommerceFixture',use_case:{type:'account_onboarding',account_onboarding:{configurations:['merchant'],return_url:'http://localhost:5297/commerce',refresh_url:'http://localhost:5297/commerce?connect=refresh'}}}));
    getV2.mockResolvedValue({...active,closed:true} as any);
    expect((await signedWebhook({...event,id:`evt_${randomUUID()}`,type:'v2.core.account.closed'},true,'/v1/stripe/commerce-account-webhook')).statusCode).toBe(200);
    await expect(onlineGift()).rejects.toMatchObject({code:'VALIDATION_FAILED'});
  }finally {
    vi.restoreAllMocks();
    // Restore this test's shared provider fixture only; no real account is downgraded.
    await withTenant(tenant,tx=>tx`update commerce_accounts set api_version='v1',charges_enabled=true,payouts_enabled=true,disconnected=false where location_id=${tenant.locationId}`);
  }
});
it('handles Connect disconnection without metadata, stops new online sales, and preserves funded assets',async()=>{
  const o=await onlineGift();await signedWebhook(await paidEvent(o));
  const event={id:`evt_${randomUUID()}`,account:'acct_CommerceFixture',livemode:false,type:'account.application.deauthorized',data:{object:{id:'ca_fixture',object:'application'}}} as unknown as Stripe.Event;
  expect((await signedWebhook(event)).statusCode).toBe(200);
  const sdk=stripeClient();const retrieve=vi.spyOn(sdk.accounts,'retrieve').mockResolvedValue({id:'acct_CommerceFixture',charges_enabled:true,payouts_enabled:true,details_submitted:true,capabilities:{card_payments:'active'}} as any);
  try{expect((await signedWebhook({...event,id:`evt_${randomUUID()}`,type:'account.updated',data:{object:{id:'acct_CommerceFixture'}}})).statusCode).toBe(200);}
  finally{retrieve.mockRestore();}
  await expect(onlineGift()).rejects.toMatchObject({code:'VALIDATION_FAILED'});
  const [card]=await withTenant(tenant,tx=>tx`select g.balance_cents from gift_cards g join commerce_orders o on o.asset_id=g.id where o.id=${o.orderId}`);
  expect(card!.balance_cents).toBe(10000);
});
it('keeps gift promotional-value cent rounding consistent across multiple purchase refunds',async()=>{
  const order=await offlineGift();
  for(let i=0;i<4;i++){
    const refund=await run<{refundId:string}>('commerce.requestRefund',{paymentId:order.paymentId,amountCents:1,reason:'Rounding QA'});
    await run('commerce.confirmOfflineRefund',{refundId:refund.refundId,reference:`Rounding QA ${i}`});
  }
  const [g]=await withTenant(tenant,tx=>tx`select balance_cents,reserved_cents from gift_cards where id=${order.assetId}`);
  expect(g).toMatchObject({balance_cents:9995,reserved_cents:0});
});
it('never lets customer connected-account events enter platform SaaS or AI-credit billing',async()=>{
  const [before]=await withTenant(tenant,tx=>tx`select to_jsonb(b) as data from billing_accounts b where location_id=${tenant.locationId}`);
  const e={id:`evt_${randomUUID()}`,account:'acct_CommerceFixture',livemode:false,type:'invoice.paid',
    data:{object:{id:'in_customer_membership',amount_paid:9900,currency:'usd',metadata:metadataOf(ctx,randomUUID())}}} as unknown as Stripe.Event;
  const response=await signedWebhook(e,true,'/v1/stripe/webhook');
  expect(response.statusCode).toBe(200);expect(response.json().result).toBe('ignored_customer_commerce');
  const [after]=await withTenant(tenant,tx=>tx`select to_jsonb(b) as data from billing_accounts b where location_id=${tenant.locationId}`);
  expect(after).toEqual(before);
});
it('freezes the whole package while a partial purchase refund is pending, preserving cent allocation',async()=>{
  const {order}=await sellPackage();
  const refund=await run<{refundId:string}>('commerce.requestRefund',{paymentId:order.paymentId,amountCents:5000,reason:'One unused session'});
  await expect(run('package.redeem',{packageId:order.assetId,customerId,units:1})).rejects.toMatchObject({code:'VALIDATION_FAILED'});
  await expect(run('commerce.requestRefund',{paymentId:order.paymentId,amountCents:5000,reason:'Overlapping request'})).rejects.toMatchObject({code:'VALIDATION_FAILED'});
  await run('commerce.confirmOfflineRefund',{refundId:refund.refundId,reference:'Returned one session'});
  await run('package.redeem',{packageId:order.assetId,customerId,units:1});
  const [asset]=await withTenant(tenant,tx=>tx`select remaining_sessions,refund_frozen from customer_packages where id=${order.assetId}`);
  expect(asset).toMatchObject({remaining_sessions:8,refund_frozen:false});
});

it('returns an originally paid package unit only after complete service coverage, retains other unused purchase refunds and never creates cash',async()=>{
 const {order,serviceId}=await sellPackage();const [staff]=await withTenant(ctx,tx=>tx<{membership_id:string}[]>`select membership_id from staff_profiles where location_id=${ctx.locationId} and is_bookable limit 1`);
 const t=await run<{ticketId:string}>('ticket.open',{customerId,items:[{serviceId,membershipId:staff!.membership_id,priceCentsOverride:10000}]});
 await withTenant(ctx,tx=>tx`update ticket_items set started_at=now(),finished_at=now() where ticket_id=${t.ticketId}`);
 await run('ticket.pay',{ticketId:t.ticketId,packageRedemptions:[{customerPackageId:order.assetId,units:1}],payments:[]});
 const unused=await run<{refundId:string}>('commerce.requestRefund',{paymentId:order.paymentId,amountCents:45000,reason:'Return nine unused visits'});await run('commerce.confirmOfflineRefund',{refundId:unused.refundId,reference:'QA unused purchase refund'});
 const one={ticketId:t.ticketId,refundAmountCents:4000,refundMethod:'original_payment',reason:'customer_dissatisfied'},key=randomUUID();await run('ticket.refund',one,key);await run('ticket.refund',one,key);
 let [asset]=await withTenant(ctx,tx=>tx`select remaining_sessions,available_units from customer_packages where id=${order.assetId}`);expect(asset).toMatchObject({remaining_sessions:0,available_units:'{}'});
 await run('ticket.refund',{...one,refundAmountCents:6000});
 [asset]=await withTenant(ctx,tx=>tx`select remaining_sessions,available_units from customer_packages where id=${order.assetId}`);expect(asset).toMatchObject({remaining_sessions:1,available_units:'{[0,1)}'});
 const [facts]=await withTenant(ctx,tx=>tx`select (select sum(package_cents)::int from ticket_refunds where ticket_id=${t.ticketId}) as restored_coverage,
  (select coalesce(sum(cash_cents+card_cents+customer_credit_cents),0)::int from ticket_refunds where ticket_id=${t.ticketId}) as new_money,
  (select count(*)::int from customer_package_ledger where package_id=${order.assetId} and entry='restore') as restores,
  (select sum(value_cents)::int from customer_package_ledger where package_id=${order.assetId}) as remaining_value,
  (select sum(base_cents)::int from earnings where ticket_id=${t.ticketId} and kind='commission') as commission`);
 expect(facts).toMatchObject({restored_coverage:10000,new_money:0,restores:1,remaining_value:5000,commission:0});
 await expect(run('ticket.refund',{...one,refundAmountCents:1})).rejects.toBeDefined();
});
it('records separate package execution units with their own funded commission bases and never restores fractional units',async()=>{
 const {order,serviceId}=await sellPackage(2,10000);const [staff]=await withTenant(ctx,tx=>tx<{membership_id:string}[]>`select membership_id from staff_profiles where location_id=${ctx.locationId} and is_bookable limit 1`);
 const t=await run<{ticketId:string}>('ticket.open',{customerId,items:[10000,5000].map(price=>({serviceId,membershipId:staff!.membership_id,priceCentsOverride:price}))});await withTenant(ctx,tx=>tx`update ticket_items set started_at=now(),finished_at=now() where ticket_id=${t.ticketId}`);
 await run('ticket.pay',{ticketId:t.ticketId,packageRedemptions:[{customerPackageId:order.assetId,units:2}],payments:[]});
 const units=await withTenant(ctx,tx=>tx`select quantity,value_cents from customer_package_ledger where ticket_id=${t.ticketId} and entry='redeem'`);expect(units).toEqual([{quantity:-1,value_cents:-5000},{quantity:-1,value_cents:-5000}]);
 const bases=await withTenant(ctx,tx=>tx`select (line->>'baseCents')::int as base_cents from earnings e cross join jsonb_array_elements(e.basis->'itemLines')line where ticket_id=${t.ticketId} and kind='commission' order by line->>'ticketItemId'`);expect(bases.map(b=>b.base_cents)).toEqual([5000,5000]);
 await expect(run('ticket.refund',{ticketId:t.ticketId,refundAmountCents:5000,refundMethod:'cash',reason:'other'})).rejects.toMatchObject({details:{reason:'prepaid_refund_requires_original_method'}});
 await run('ticket.refund',{ticketId:t.ticketId,refundAmountCents:7500,refundMethod:'original_payment',reason:'other'});
 const [a]=await withTenant(ctx,tx=>tx`select remaining_sessions from customer_packages where id=${order.assetId}`);expect(a!.remaining_sessions).toBe(0);
 await run('ticket.refund',{ticketId:t.ticketId,refundAmountCents:7500,refundMethod:'original_payment',reason:'other'});
 const [b]=await withTenant(ctx,tx=>tx`select remaining_sessions from customer_packages where id=${order.assetId}`);expect(b!.remaining_sessions).toBe(2);
});

it('keeps returned expired package units unavailable and enforces immutable complete scoped source receipts',async()=>{
 const {order,serviceId}=await sellPackage(1,5000);const [staff]=await withTenant(ctx,tx=>tx<{membership_id:string}[]>`select membership_id from staff_profiles where location_id=${ctx.locationId} and is_bookable limit 1`);
 const t=await run<{ticketId:string}>('ticket.open',{customerId,items:[{serviceId,membershipId:staff!.membership_id,priceCentsOverride:10000}]});await withTenant(ctx,tx=>tx`update ticket_items set started_at=now(),finished_at=now() where ticket_id=${t.ticketId}`);
 await run('ticket.pay',{ticketId:t.ticketId,packageRedemptions:[{customerPackageId:order.assetId,units:1}],payments:[]});
 const [source]=await withTenant(ctx,tx=>tx`select * from ticket_settlement_sources where ticket_id=${t.ticketId}`);
 await expect(withTenant(ctx,tx=>tx`update ticket_settlement_sources set amount_cents=1 where id=${source!.id}`)).rejects.toMatchObject({code:'42501'});
 await expect(withTenant(ctx,tx=>tx`delete from ticket_source_receipts where ticket_id=${t.ticketId}`)).rejects.toMatchObject({code:'42501'});
 const foreign={...ctx,orgId:'11111111-1111-4111-8111-111111111111',locationId:'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'};
 expect(await withTenant(foreign,tx=>tx`select id from ticket_settlement_sources where id=${source!.id}`)).toHaveLength(0);
 await expect(withTenant(ctx,tx=>tx`insert into ticket_refunds(org_id,location_id,ticket_id,business_date,amount_cents,service_cents,tax_cents,fee_cents,tip_cents,cash_cents,card_cents,gift_card_cents,customer_credit_cents,package_cents,method,reason,refunded_by)
  select org_id,location_id,id,business_date,1,1,0,0,0,0,0,0,0,1,'original_payment','other',${ctx.membershipId} from tickets where id=${t.ticketId}`)).rejects.toMatchObject({code:'23001'});
 await withTenant(ctx,tx=>tx`update customer_packages set expires_at=now()-interval '1 second' where id=${order.assetId}`);
 await run('ticket.refund',{ticketId:t.ticketId,refundAmountCents:10000,refundMethod:'original_payment',reason:'other'});
 const [facts]=await withTenant(ctx,tx=>tx`select remaining_sessions,available_units,(select count(*)::int from customer_package_ledger where package_id=cp.id and entry='restore') as restores,
  (select count(*)::int from customer_package_ledger where package_id=cp.id and entry='expire') as expired_returns,
  (select sum(quantity)::int from customer_package_ledger where package_id=cp.id) as live_units from customer_packages cp where id=${order.assetId}`);
 expect(facts).toMatchObject({remaining_sessions:0,available_units:'{}',restores:1,expired_returns:1,live_units:0});
 await expect(run('package.redeem',{packageId:order.assetId,customerId,units:1})).rejects.toBeDefined();
 await expect(dispatch('ticket.refund',{ticketId:t.ticketId,refundAmountCents:1,reason:'other'},ctx)).rejects.toMatchObject({code:'VALIDATION_FAILED'});
});
it('restores original gift service coverage after refunding the other unused purchase value without reopening a disabled credential',async()=>{
 const order=await offlineGift();const [service]=await withTenant(ctx,tx=>tx`select id from services where location_id=${ctx.locationId} and active limit 1`),[staff]=await withTenant(ctx,tx=>tx`select membership_id from staff_profiles where location_id=${ctx.locationId} and is_bookable limit 1`);
 const t=await run<{ticketId:string}>('ticket.open',{customerId,items:[{serviceId:service!.id,membershipId:staff!.membership_id,priceCentsOverride:3000}]});await withTenant(ctx,tx=>tx`update ticket_items set started_at=now(),finished_at=now() where ticket_id=${t.ticketId}`);
 await run('ticket.pay',{ticketId:t.ticketId,payments:[{method:'gift_card',giftCardId:order.assetId,amountCents:3000}]});
 const unused=await run<{refundId:string}>('commerce.requestRefund',{paymentId:order.paymentId,amountCents:5600,reason:'Return unused face value'});await run('commerce.confirmOfflineRefund',{refundId:unused.refundId,reference:'Unused gift value returned'});
 await withTenant(ctx,tx=>tx`update gift_cards set credential_disabled=true where id=${order.assetId}`);
 const input={ticketId:t.ticketId,refundAmountCents:3000,refundMethod:'original_payment',reason:'other'},key=randomUUID();await run('ticket.refund',input,key);await run('ticket.refund',input,key);
 const [g]=await withTenant(ctx,tx=>tx`select balance_cents,status,credential_disabled,(select sum(amount_cents)::int from commerce_refunds where payment_id=${order.paymentId} and status='succeeded') as purchase_refund,
  (select sum(cash_cents+card_cents+customer_credit_cents)::int from ticket_refunds where ticket_id=${t.ticketId}) as new_money from gift_cards where id=${order.assetId}`);
 expect(g).toMatchObject({balance_cents:3000,status:'active',credential_disabled:true,purchase_refund:5600,new_money:0});
});

it('returns only the selected original package item and its funded commission while another service and its cash tip remain intact',async()=>{
 const {order,serviceId}=await sellPackage(1,5000),[staff]=await withTenant(ctx,tx=>tx<{membership_id:string}[]>`select membership_id from staff_profiles where location_id=${ctx.locationId} and is_bookable limit 1`);
 const ticket=await run<{ticketId:string}>('ticket.open',{customerId,items:[10000,20000].map(price=>({serviceId,membershipId:staff!.membership_id,priceCentsOverride:price}))});
 await withTenant(ctx,tx=>tx`update ticket_items set started_at=now(),finished_at=now() where ticket_id=${ticket.ticketId}`);
 await run('ticket.pay',{ticketId:ticket.ticketId,packageRedemptions:[{customerPackageId:order.assetId,units:1}],payments:[{method:'cash',amountCents:21000,tipCents:1000}]});
 const items=await withTenant(ctx,tx=>tx<{id:string}[]>`select id from ticket_items where ticket_id=${ticket.ticketId} order by seq,id`);
 const first={ticketId:ticket.ticketId,refundAmountCents:10000,refundTipCents:0,refundMethod:'original_payment',reason:'other',refundItems:[{ticketItemId:items[0]!.id,amountCents:10000}]};
 const review=await run<{reviewHash:string;itemGraphAvailable:boolean;destinations:Array<{kind:string;amountCents:number}>;items:Array<{ticketItemId:string;remainingCents:number}>}>('ticket.reviewRefund',first);
 expect(review.itemGraphAvailable).toBe(true);expect(review.destinations).toEqual([{kind:'package',amountCents:10000}]);expect(review.items.map(i=>i.remainingCents)).toEqual([10000,20000]);
 const key=randomUUID();await run('ticket.refund',{...first,reviewHash:review.reviewHash},key);await run('ticket.refund',{...first,reviewHash:review.reviewHash},key);
 const [remaining]=await withTenant(ctx,tx=>tx`select (select remaining_sessions from customer_packages where id=${order.assetId}) as units,
  (select sum(base_cents)::int from earnings where ticket_id=${ticket.ticketId} and kind='commission') as base,
  (select sum(amount_cents)::int from tip_allocations where ticket_id=${ticket.ticketId}) as tips,
  (select sum(cash_cents)::int from ticket_refunds where ticket_id=${ticket.ticketId}) as cash_return`);
 expect(remaining).toMatchObject({units:1,base:20000,tips:1000,cash_return:0});
 await expect(run('ticket.refund',{...first,refundAmountCents:1,refundItems:[{ticketItemId:items[0]!.id,amountCents:1}]})).rejects.toMatchObject({details:{reason:'item_refund_exceeds_original'}});
 await run('ticket.refund',{...first,refundAmountCents:8000,refundItems:[{ticketItemId:items[1]!.id,amountCents:8000}]});
 const [partial]=await withTenant(ctx,tx=>tx`select sum(base_cents)::int as base from earnings where ticket_id=${ticket.ticketId} and kind='commission'`);expect(partial!.base).toBe(12000);
 await run('ticket.refund',{...first,refundAmountCents:13000,refundTipCents:1000,refundItems:[{ticketItemId:items[1]!.id,amountCents:12000}]});
 const [final]=await withTenant(ctx,tx=>tx`select t.status,t.refund_cents,(select sum(base_cents)::int from earnings where ticket_id=t.id and kind='commission') as base,
  (select sum(amount_cents)::int from tip_allocations where ticket_id=t.id) as tips,(select sum(cash_cents)::int from ticket_refunds where ticket_id=t.id) as cash_return,
  (select remaining_sessions from customer_packages where id=${order.assetId}) as units from tickets t where id=${ticket.ticketId}`);
 expect(final).toMatchObject({status:'refunded',refund_cents:31000,base:0,tips:0,cash_return:21000,units:1});
});
it('returns selected frozen inclusive and exclusive tax and fee components after current shop pricing changes',async()=>{
 const [prior]=await withTenant(ctx,tx=>tx`select sales_tax_rate_percent,tax_calculation_mode from location_checkout_settings where location_id=${ctx.locationId}`);
 try{for(const mode of ['inclusive','exclusive']){
  await withTenant(ctx,tx=>tx`update location_checkout_settings set sales_tax_rate_percent=6.5,tax_calculation_mode=${mode} where location_id=${ctx.locationId}`);
  const {order,serviceId}=await sellPackage(1,5000),[staff]=await withTenant(ctx,tx=>tx`select membership_id from staff_profiles where location_id=${ctx.locationId} and is_bookable limit 1`);
  const ticket=await run<{ticketId:string}>('ticket.open',{customerId,items:[10000,20000].map(price=>({serviceId,membershipId:staff!.membership_id,priceCentsOverride:price}))});await withTenant(ctx,tx=>tx`update ticket_items set started_at=now(),finished_at=now() where ticket_id=${ticket.ticketId}`);
  const amount=mode==='inclusive'?21201:22501;
  await run('ticket.pay',{ticketId:ticket.ticketId,surchargeCents:201,packageRedemptions:[{customerPackageId:order.assetId,units:1}],payments:[{method:'cash',amountCents:amount,tipCents:1000}]});
  const rows=await withTenant(ctx,tx=>tx`select i.ticket_item_id,i.service_cents,i.tax_cents,i.fee_cents,i.tax_mode from ticket_item_settlements i join ticket_items t on t.id=i.ticket_item_id where i.ticket_id=${ticket.ticketId} order by t.seq`);
  expect(rows[0]).toMatchObject({service_cents:10000,tax_cents:0,fee_cents:67,tax_mode:mode});expect(rows[1]!.fee_cents).toBe(134);
  await withTenant(ctx,tx=>tx`update location_checkout_settings set sales_tax_rate_percent=19,tax_calculation_mode=${mode==='inclusive'?'exclusive':'inclusive'} where location_id=${ctx.locationId}`);
  await run('ticket.refund',{ticketId:ticket.ticketId,refundAmountCents:10000,refundItems:[{ticketItemId:rows[0]!.ticket_item_id,amountCents:10000}],reason:'other'});
  const fee=await run<{taxCents:number;feeCents:number;destinations:unknown[]}>('ticket.reviewRefund',{ticketId:ticket.ticketId,refundAmountCents:67,refundItems:[{ticketItemId:rows[0]!.ticket_item_id,amountCents:67}]});expect(fee).toMatchObject({taxCents:0,feeCents:67,destinations:[{kind:'cash',amountCents:67}]});
  await run('ticket.refund',{ticketId:ticket.ticketId,refundAmountCents:67,refundItems:[{ticketItemId:rows[0]!.ticket_item_id,amountCents:67}],reason:'other'});
  const remaining=rows[1]!.service_cents+rows[1]!.tax_cents+rows[1]!.fee_cents;
  const review=await run<{taxCents:number;feeCents:number}>('ticket.reviewRefund',{ticketId:ticket.ticketId,refundAmountCents:remaining+1000,refundTipCents:1000,refundItems:[{ticketItemId:rows[1]!.ticket_item_id,amountCents:remaining}]});expect(review.taxCents).toBe(rows[1]!.tax_cents);expect(review.feeCents).toBe(134);
  await run('ticket.refund',{ticketId:ticket.ticketId,refundAmountCents:remaining+1000,refundTipCents:1000,refundItems:[{ticketItemId:rows[1]!.ticket_item_id,amountCents:remaining}],reason:'other'});
  const [total]=await withTenant(ctx,tx=>tx`select t.refund_cents,t.total_cents,(select sum(base_cents)::int from earnings where ticket_id=t.id and kind='commission') as base from tickets t where id=${ticket.ticketId}`);expect(total!.refund_cents).toBe(total!.total_cents);expect(total!.base).toBe(0);
 }}finally{await withTenant(ctx,tx=>tx`update location_checkout_settings set sales_tax_rate_percent=${prior!.sales_tax_rate_percent},tax_calculation_mode=${prior!.tax_calculation_mode} where location_id=${ctx.locationId}`);}
});
it('restores one bundled package unit only after every covered execution has been returned',async()=>{
 const services=await withTenant(ctx,tx=>tx<{id:string}[]>`select id from services where location_id=${ctx.locationId} and active order by sort,id limit 2`);
 const [staff]=await withTenant(ctx,tx=>tx`select membership_id from staff_profiles where location_id=${ctx.locationId} and is_bookable limit 1`);
 const template=await run<{templateId:string}>('package.saveTemplate',{name:'Two execution unit',priceCents:6000,sessions:1,validDays:365,serviceIds:services.map(s=>s.id),coverageMode:'bundle',commissionBasis:'sale_price'});
 const order=await run('commerce.createOrder',{kind:'package',channel:'offline',templateId:template.templateId,customerId,businessKey:randomUUID(),offlinePayment:{method:'cash',amountCents:6000,reference:'Bundle return QA'}});
 const ticket=await run<{ticketId:string}>('ticket.open',{customerId,items:services.map((s,index)=>({serviceId:s.id,membershipId:staff!.membership_id,priceCentsOverride:index===0?10000:20000}))});
 await withTenant(ctx,tx=>tx`update ticket_items set started_at=now(),finished_at=now() where ticket_id=${ticket.ticketId}`);
 await run('ticket.pay',{ticketId:ticket.ticketId,packageRedemptions:[{customerPackageId:order.assetId,units:1}],payments:[]});
 const items=await withTenant(ctx,tx=>tx`select id,total_cents from ticket_items where ticket_id=${ticket.ticketId} order by seq,id`);
 const refund=(index:number)=>({ticketId:ticket.ticketId,refundAmountCents:items[index]!.total_cents,refundItems:[{ticketItemId:items[index]!.id,amountCents:items[index]!.total_cents}],reason:'other'});
 await run('ticket.refund',refund(0));
 const [partial]=await withTenant(ctx,tx=>tx`select remaining_sessions,(select sum(base_cents)::int from earnings where ticket_id=${ticket.ticketId} and kind='commission') as base from customer_packages where id=${order.assetId}`);
 expect(partial).toMatchObject({remaining_sessions:0,base:4000});
 const key=randomUUID();await run('ticket.refund',refund(1),key);await run('ticket.refund',refund(1),key);
 const [final]=await withTenant(ctx,tx=>tx`select remaining_sessions,(select count(*)::int from customer_package_ledger where package_id=cp.id and entry='restore') as restores,(select sum(base_cents)::int from earnings where ticket_id=${ticket.ticketId} and kind='commission') as base from customer_packages cp where id=${order.assetId}`);
 expect(final).toMatchObject({remaining_sessions:1,restores:1,base:0});
});
it('rejects foreign execution references, source edits and a complete service return that omits the original commission reversal',async()=>{
 const {order,serviceId}=await sellPackage(1,5000),[staff]=await withTenant(ctx,tx=>tx`select membership_id from staff_profiles where location_id=${ctx.locationId} and is_bookable limit 1`);
 const ticket=await run<{ticketId:string}>('ticket.open',{customerId,items:[{serviceId,membershipId:staff!.membership_id,priceCentsOverride:10000}]});await withTenant(ctx,tx=>tx`update ticket_items set started_at=now(),finished_at=now() where ticket_id=${ticket.ticketId}`);await run('ticket.pay',{ticketId:ticket.ticketId,packageRedemptions:[{customerPackageId:order.assetId,units:1}],payments:[]});
 const [allocation]=await withTenant(ctx,tx=>tx`select a.* from ticket_item_source_allocations a join ticket_settlement_sources s on s.id=a.source_id where s.ticket_id=${ticket.ticketId}`);
 await expect(withTenant(ctx,tx=>tx`update ticket_item_settlements set service_cents=1 where ticket_item_id=${allocation!.ticket_item_id}`)).rejects.toMatchObject({code:'42501'});
 await expect(withTenant(ctx,tx=>tx`delete from ticket_item_commission_sources where ticket_item_id=${allocation!.ticket_item_id}`)).rejects.toMatchObject({code:'42501'});
 await expect(run('ticket.reviewRefund',{ticketId:ticket.ticketId,refundAmountCents:1,refundItems:[{ticketItemId:randomUUID(),amountCents:1}]})).rejects.toMatchObject({details:{reason:'invalid_refund_items'}});
 const foreign={...ctx,orgId:'11111111-1111-4111-8111-111111111111',locationId:'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'};
 expect(await withTenant(foreign,tx=>tx`select id from ticket_item_source_allocations where id=${allocation!.id}`)).toHaveLength(0);
 await expect(withTenant(ctx,async tx=>{
  const [r]=await tx`insert into ticket_refunds(org_id,location_id,ticket_id,business_date,amount_cents,service_cents,tax_cents,fee_cents,tip_cents,cash_cents,card_cents,gift_card_cents,customer_credit_cents,package_cents,method,reason,refunded_by)
   select org_id,location_id,id,business_date,10000,10000,0,0,0,0,0,0,0,10000,'original_payment','other',${ctx.membershipId} from tickets where id=${ticket.ticketId} returning id`;
  await tx`insert into ticket_source_refunds(org_id,location_id,ticket_refund_id,source_id,amount_cents,tip_cents,destination,service_cents,tax_cents,fee_cents) values(${ctx.orgId},${ctx.locationId},${r!.id},${allocation!.source_id},10000,0,'package',10000,0,0)`;
  await tx`insert into ticket_item_source_returns(org_id,location_id,ticket_refund_id,source_id,allocation_id,service_cents,tax_cents,fee_cents) values(${ctx.orgId},${ctx.locationId},${r!.id},${allocation!.source_id},${allocation!.id},10000,0,0)`;
 })).rejects.toMatchObject({code:'23001'});
 const [count]=await withTenant(ctx,tx=>tx`select count(*)::int as n from ticket_refunds where ticket_id=${ticket.ticketId}`);expect(count!.n).toBe(0);
});

it('quotes the real package and tax rules without financial writes and rejects changed quotes atomically',async()=>{
 const {order,serviceId}=await sellPackage(1,5000),[staff]=await withTenant(ctx,tx=>tx`select membership_id from staff_profiles where location_id=${ctx.locationId} and is_bookable limit 1`);
 const ticket=await run<{ticketId:string}>('ticket.open',{customerId,items:[10000,20000].map(price=>({serviceId,membershipId:staff!.membership_id,priceCentsOverride:price}))});await withTenant(ctx,tx=>tx`update ticket_items set started_at=now(),finished_at=now() where ticket_id=${ticket.ticketId}`);
 const input={ticketId:ticket.ticketId,packageRedemptions:[{customerPackageId:order.assetId,units:1}],tipCents:1000};
 const state=()=>withTenant(ctx,tx=>tx`select remaining_sessions,available_units,(select count(*)::int from customer_package_ledger where package_id=cp.id) as ledger,(select count(*)::int from payments where ticket_id=${ticket.ticketId}) as payments,(select count(*)::int from ticket_price_adjustments where ticket_id=${ticket.ticketId}) as discounts from customer_packages cp where id=${order.assetId}`);
 const before=await state();
 const first=await run<{quoteHash:string;amountDueCents:number;items:Array<{coverage:string}>}>('ticket.quoteCheckout',input),again=await run<{quoteHash:string}>('ticket.quoteCheckout',input);
 expect(first.amountDueCents).toBe(21000);expect(first.items.map(i=>i.coverage)).toEqual(['package','money']);expect(first.quoteHash).toBe(again.quoteHash);expect(await state()).toEqual(before);
 const [old]=await withTenant(ctx,tx=>tx`select sales_tax_rate_percent from location_checkout_settings where location_id=${ctx.locationId}`);
 try{
  await withTenant(ctx,tx=>tx`update location_checkout_settings set sales_tax_rate_percent=6.5 where location_id=${ctx.locationId}`);
  await expect(run('ticket.pay',{...input,expectedQuoteHash:first.quoteHash,payments:[{method:'cash',amountCents:22300,tipCents:1000}]})).rejects.toMatchObject({details:{reason:'checkout_quote_changed'}});
  expect(await state()).toEqual(before);
  const next=await run<{quoteHash:string;amountDueCents:number}>('ticket.quoteCheckout',input);expect(next.amountDueCents).toBe(22300);expect(next.quoteHash).not.toBe(first.quoteHash);
  await run('ticket.pay',{...input,expectedQuoteHash:next.quoteHash,payments:[{method:'cash',amountCents:next.amountDueCents,tipCents:1000}]});
  const after=await state();expect(after[0]).toMatchObject({remaining_sessions:0,payments:1,ledger:2});
 }finally{await withTenant(ctx,tx=>tx`update location_checkout_settings set sales_tax_rate_percent=${old!.sales_tax_rate_percent} where location_id=${ctx.locationId}`);}
});

it('quotes and settles a group against the original package and gift budgets without consuming during review',async()=>{
 const {order,serviceId}=await sellPackage(1,5000),gift=await offlineGift(),[staff]=await withTenant(ctx,tx=>tx`select membership_id from staff_profiles where location_id=${ctx.locationId} and is_bookable limit 1`);
 const tickets:string[]=[];for(const price of [10000,20000]){const t=await run<{ticketId:string}>('ticket.open',{customerId,items:[{serviceId,membershipId:staff!.membership_id,priceCentsOverride:price}]});await withTenant(ctx,tx=>tx`update ticket_items set started_at=now(),finished_at=now() where ticket_id=${t.ticketId}`);tickets.push(t.ticketId);}
 const group=await run<{groupId:string}>('ticket.group',{ticketIds:tickets});
 const selection={groupId:group.groupId,ticketIds:tickets,payerTicketId:tickets[1],ticketSelections:[{ticketId:tickets[0],packageRedemptions:[{customerPackageId:order.assetId,units:1}],tipCents:0},{ticketId:tickets[1],storedValuePayments:[{method:'gift_card',giftCardId:gift.assetId,amountCents:3000}],tipCents:1000,tipSplits:[{staffMembershipId:staff!.membership_id,amountCents:1000}]}]};
 const facts=()=>withTenant(ctx,tx=>tx`select (select remaining_sessions from customer_packages where id=${order.assetId}) as units,(select balance_cents from gift_cards where id=${gift.assetId}) as gift,(select count(*)::int from payments where ticket_id=any(${tickets}::uuid[])) as payments`);
 await expect(run('ticket.quoteGroup',{...selection,tipCents:999})).rejects.toMatchObject({details:{reason:'group_tip_selection_mismatch'}});
 const before=await facts(),draft=await run<{amountDueCents:number;readyToPay:boolean}>('ticket.quoteGroup',{...selection,tipCents:1000});expect(draft).toMatchObject({amountDueCents:18000,readyToPay:false});expect(await facts()).toEqual(before);
 const input={...selection,payments:[{method:'cash',amountCents:18000,tipCents:1000,tenderedCents:20000,changeCents:2000}]};
 const quote=await run<{quoteHash:string;readyToPay:boolean;storedValueCents:number;amountDueCents:number}>('ticket.quoteGroup',input);expect(quote).toMatchObject({readyToPay:true,storedValueCents:3000,amountDueCents:18000});expect(await facts()).toEqual(before);
 const key=randomUUID();await run('ticket.closeGroup',{...input,expectedQuoteHash:quote.quoteHash},key);await run('ticket.closeGroup',{...input,expectedQuoteHash:quote.quoteHash},key);
 expect((await facts())[0]).toMatchObject({units:0,gift:7000,payments:2});
 const [tipAllocation]=await withTenant(ctx,tx=>tx`select membership_id,sum(amount_cents)::int as amount from tip_allocations where ticket_id=${tickets[1]!} group by membership_id`);expect(tipAllocation).toMatchObject({membership_id:staff!.membership_id,amount:1000});
 const [tender]=await withTenant(ctx,tx=>tx`select sum(tendered_cents)::int as tendered,sum(change_cents)::int as change from payments where ticket_id=any(${tickets}::uuid[])`);expect(tender).toMatchObject({tendered:20000,change:2000});
 await run('ticket.refund',{ticketId:tickets[0],refundAmountCents:10000,reason:'other'});await run('ticket.refund',{ticketId:tickets[1],refundAmountCents:21000,refundTipCents:1000,reason:'other'});
 const [final]=await withTenant(ctx,tx=>tx`select (select remaining_sessions from customer_packages where id=${order.assetId}) as units,(select balance_cents from gift_cards where id=${gift.assetId}) as gift,(select sum(base_cents)::int from earnings where ticket_id=any(${tickets}::uuid[]) and kind='commission') as commission,(select sum(cash_cents)::int from ticket_refunds where ticket_id=any(${tickets}::uuid[])) as cash`);
 expect(final).toMatchObject({units:1,gift:10000,commission:0,cash:18000});
});
it('rejects sharing the last package unit twice inside one group quote and never writes a partial settlement',async()=>{
 const {order,serviceId}=await sellPackage(1,5000),[staff]=await withTenant(ctx,tx=>tx`select membership_id from staff_profiles where location_id=${ctx.locationId} and is_bookable limit 1`);
 const ids:string[]=[];for(let i=0;i<2;i++){const t=await run<{ticketId:string}>('ticket.open',{customerId,items:[{serviceId,membershipId:staff!.membership_id,priceCentsOverride:10000}]});await withTenant(ctx,tx=>tx`update ticket_items set started_at=now(),finished_at=now() where ticket_id=${t.ticketId}`);ids.push(t.ticketId);}
 const group=await run<{groupId:string}>('ticket.group',{ticketIds:ids}),input={groupId:group.groupId,ticketIds:ids,ticketSelections:ids.map(ticketId=>({ticketId,packageRedemptions:[{customerPackageId:order.assetId,units:1}]})),payments:[]};
 await expect(run('ticket.quoteGroup',input)).rejects.toMatchObject({details:{reason:'insufficient_sessions'}});
 await expect(run('ticket.closeGroup',input)).rejects.toMatchObject({details:{reason:'insufficient_sessions'}});
 const [after]=await withTenant(ctx,tx=>tx`select remaining_sessions,(select count(*)::int from customer_package_ledger where package_id=cp.id and entry='redeem') as redemptions,(select count(*)::int from payments where ticket_id=any(${ids}::uuid[])) as payments from customer_packages cp where id=${order.assetId}`);
 expect(after).toMatchObject({remaining_sessions:1,redemptions:0,payments:0});
});
it('includes original gift selection in the checkout quote and rejects another card on confirmation',async()=>{
 const one=await offlineGift(),two=await offlineGift(),[service]=await withTenant(ctx,tx=>tx`select id from services where active and location_id=${ctx.locationId} limit 1`),[staff]=await withTenant(ctx,tx=>tx`select membership_id from staff_profiles where location_id=${ctx.locationId} and is_bookable limit 1`);
 const t=await run<{ticketId:string}>('ticket.open',{customerId,items:[{serviceId:service!.id,membershipId:staff!.membership_id,priceCentsOverride:3000}]});await withTenant(ctx,tx=>tx`update ticket_items set started_at=now(),finished_at=now() where ticket_id=${t.ticketId}`);
 const quote=await run<{quoteHash:string;storedValueCents:number;newMoneyDueCents:number}>('ticket.quoteCheckout',{ticketId:t.ticketId,storedValuePayments:[{method:'gift_card',giftCardId:one.assetId,amountCents:3000}]});expect(quote).toMatchObject({storedValueCents:3000,newMoneyDueCents:0});
 await expect(run('ticket.pay',{ticketId:t.ticketId,expectedQuoteHash:quote.quoteHash,payments:[{method:'gift_card',giftCardId:two.assetId,amountCents:3000}]})).rejects.toMatchObject({details:{reason:'checkout_quote_changed'}});
 const cards=await withTenant(ctx,tx=>tx`select balance_cents from gift_cards where id=any(${[one.assetId,two.assetId]}::uuid[])`);expect(cards.every(c=>c.balance_cents===10000)).toBe(true);
 await run('ticket.pay',{ticketId:t.ticketId,expectedQuoteHash:quote.quoteHash,payments:[{method:'gift_card',giftCardId:one.assetId,amountCents:3000}]});
});

it('reconciles prepaid cash sales and original purchase refunds without counting service use as new cash',async()=>{
 const day=await withTenant(ctx,tx=>resolveDate(tx,ctx.locationId));
 const before=await withTenant(ctx,tx=>loadDayMoney(tx,ctx.locationId,day)),gift=await offlineGift(),pkg=await sellPackage(2,10000);
 const received=await withTenant(ctx,tx=>loadDayMoney(tx,ctx.locationId,day));expect(received.cashTakeCents-before.cashTakeCents).toBe(18000);expect(received.netCents).toBe(before.netCents);
 const c0=before.commerce.currencies.find(c=>c.currency==='usd')!,c1=received.commerce.currencies.find(c=>c.currency==='usd')!;
 expect(c1.giftFaceRemainingCents-c0.giftFaceRemainingCents).toBe(10000);expect(c1.packageUnitsRemaining-c0.packageUnitsRemaining).toBe(2);
 const [staff]=await withTenant(ctx,tx=>tx`select membership_id from staff_profiles where location_id=${ctx.locationId} and is_bookable limit 1`);
 const t=await run<{ticketId:string}>('ticket.open',{customerId,items:[{serviceId:pkg.serviceId,membershipId:staff!.membership_id,priceCentsOverride:3000}]});
 await withTenant(ctx,tx=>tx`update ticket_items set started_at=now(),finished_at=now() where ticket_id=${t.ticketId}`);
 await run('ticket.pay',{ticketId:t.ticketId,payments:[{method:'gift_card',giftCardId:gift.assetId,amountCents:3000}]});
 const used=await withTenant(ctx,tx=>loadDayMoney(tx,ctx.locationId,day));expect(used.cashTakeCents).toBe(received.cashTakeCents);expect(used.netCents-received.netCents).toBe(3000);
 const refund=await run<{refundId:string}>('commerce.requestRefund',{paymentId:gift.paymentId,amountCents:5600,reason:'day-close original receipt'});
 await run('commerce.confirmOfflineRefund',{refundId:refund.refundId,reference:'cash returned'});
 const returned=await withTenant(ctx,tx=>loadDayMoney(tx,ctx.locationId,day));expect(returned.cashRefundCents-used.cashRefundCents).toBe(5600);expect(returned.movementsCents-used.movementsCents).toBe(-5600);expect(returned.netCents).toBe(used.netCents);
 const input={businessDate:day,countedCashCents:returned.cashTakeCents+returned.movementsCents-returned.tipPaidOutCents,openingFloatCents:0,closingFloatCents:0,cardTerminalCents:returned.cardTakeCents};
 const count=await run<{cashVarianceCents:number}>('dayclose.saveCount',input);expect(count.cashVarianceCents).toBe(0);
 const close=await run('dayclose.finalize',{businessDate:day,force:true});
 const sealed=await withTenant(ctx,tx=>loadDayClose(tx,ctx,day));expect(sealed.closedSnapshotAvailable).toBe(true);expect(sealed.hasPostCloseChanges).toBe(false);
 // A newly observed online payment may arrive after closing; keep the actual closed snapshot intact.
 await expect(offlineGift()).rejects.toMatchObject({code:'DAY_ALREADY_CLOSED'});
 await dispatchSystem('commerce.saveAccount',{stripeAccountId:'acct_CommerceFixture',livemode:false,chargesEnabled:true,payoutsEnabled:true,detailsSubmitted:true,capabilities:{card_payments:'active'}},ctx,{idempotencyKey:randomUUID()});
 const online=await onlineGift();await signedWebhook(await paidEvent(online));
 const later=await withTenant(ctx,tx=>loadDayClose(tx,ctx,day));expect(later.hasPostCloseChanges).toBe(true);expect(later.money).toEqual(sealed.money);expect(later.latestMoney.commerce).not.toEqual(sealed.money.commerce);
 await run('dayclose.reopen',{businessDate:day,reason:'review late verified receipt'});const reopened=await withTenant(ctx,tx=>loadDayClose(tx,ctx,day));expect(reopened.closedSnapshotAvailable).toBe(false);expect(reopened.money).toEqual(later.latestMoney);
 expect(close).toBeDefined();
});
it('uses calendar day boundaries across DST instead of fixed 24-hour windows',async()=>{
 const bounds=await withTenant(ctx,tx=>dayBounds(tx,ctx.locationId,'2026-03-07'));
 expect(bounds.to.getTime()).toBeGreaterThan(bounds.from.getTime());
 const [location]=await withTenant(ctx,tx=>tx`select timezone,business_day_cutoff from locations where id=${ctx.locationId}`);
 try{await withTenant(ctx,tx=>tx`update locations set timezone='America/New_York',business_day_cutoff='00:00:00' where id=${ctx.locationId}`);
  const spring=await withTenant(ctx,tx=>dayBounds(tx,ctx.locationId,'2026-03-08')),fall=await withTenant(ctx,tx=>dayBounds(tx,ctx.locationId,'2026-11-01'));
  expect((spring.to.getTime()-spring.from.getTime())/3600000).toBe(23);expect((fall.to.getTime()-fall.from.getTime())/3600000).toBe(25);
 }finally{await withTenant(ctx,tx=>tx`update locations set timezone=${location!.timezone},business_day_cutoff=${location!.business_day_cutoff} where id=${ctx.locationId}`);}
});
it('restores a gift card from a closed prior-day ticket using only its scoped refund fact',async()=>{
 const date=await withTenant(ctx,tx=>resolveDate(tx,ctx.locationId)),prior=new Date(Date.parse(date+'T00:00:00Z')-86400000).toISOString().slice(0,10);
 const gift=await offlineGift(),[service]=await withTenant(ctx,tx=>tx`select id from services where location_id=${ctx.locationId} and active limit 1`),[staff]=await withTenant(ctx,tx=>tx`select membership_id from staff_profiles where location_id=${ctx.locationId} and is_bookable limit 1`);
 const ticket=await run<{ticketId:string}>('ticket.open',{customerId,items:[{serviceId:service!.id,membershipId:staff!.membership_id,priceCentsOverride:3000}]});
 await withTenant(ctx,tx=>tx`update ticket_items set started_at=now(),finished_at=now() where ticket_id=${ticket.ticketId}`);
 await run('ticket.pay',{ticketId:ticket.ticketId,payments:[{method:'gift_card',giftCardId:gift.assetId,amountCents:3000},{method:'cash',amountCents:1000,tipCents:1000}]});
 await withTenant(ctx,async tx=>{await tx`update tickets set business_date=${prior} where id=${ticket.ticketId}`;await tx`update earnings set business_date=${prior} where ticket_id=${ticket.ticketId}`;});
 const before=await withTenant(ctx,tx=>loadDayMoney(tx,ctx.locationId,prior));
 await run('dayclose.saveCount',{businessDate:prior,countedCashCents:before.cashTakeCents+before.movementsCents-before.tipPaidOutCents,openingFloatCents:0,closingFloatCents:0});await run('dayclose.finalize',{businessDate:prior,force:true});
 try{
  await expect(withTenant(ctx,tx=>tx`insert into customer_credit_ledger(org_id,location_id,kind,subject_id,entry,amount_cents,balance_after_cents,ticket_id,meta) values(${ctx.orgId},${ctx.locationId},'gift_card',${gift.assetId},'refund',3000,10000,${ticket.ticketId},${JSON.stringify({refundId:randomUUID()})}::jsonb)`)).rejects.toBeDefined();
  await run('ticket.refund',{ticketId:ticket.ticketId,refundAmountCents:4000,refundTipCents:1000,reason:'other'});
  const [card]=await withTenant(ctx,tx=>tx`select balance_cents from gift_cards where id=${gift.assetId}`);expect(card!.balance_cents).toBe(10000);
  const old=await withTenant(ctx,tx=>loadDayMoney(tx,ctx.locationId,prior));expect(old.tipCashCents).toBe(before.tipCashCents);expect(old.netCents).toBe(before.netCents);
 }finally{await run('dayclose.reopen',{businessDate:prior,reason:'isolated prior-day gift return complete'});}
});
it('handles an unlimited entitlement across its actual expiry boundary and caps repeated manual refunds without reviving access',async()=>{
 const {order}=await sellPackage(0);
 const token='u'.repeat(43);await dispatchSystem('commerce.issueAccess',{orderId:order.orderId,tokenHash:createHash('sha256').update(token).digest('hex')},ctx,{idempotencyKey:randomUUID()});
 const [location]=await withTenant(tenant,tx=>tx`select slug from locations where id=${ctx.locationId}`);
 const get=()=>app.inject({url:`/v1/public/shops/${location!.slug}/commerce/orders/${order.orderId}`,headers:{'x-gf-commerce-token':token}});
 const [deadline]=await withTenant(ctx,tx=>tx`update customer_packages set expires_at=clock_timestamp()+interval '2 seconds' where id=${order.assetId} returning expires_at`);
 expect((await get()).json().asset).toMatchObject({can_redeem:true,total_sessions:0,remaining_sessions:0});
 await run('package.redeem',{packageId:order.assetId,customerId,units:1});
 await new Promise(resolve=>setTimeout(resolve,Math.max(0,new Date(deadline!.expires_at).getTime()-Date.now()+50)));
 await expect(run('package.redeem',{packageId:order.assetId,customerId,units:1})).rejects.toMatchObject({details:{reason:'package_expired'}});
 expect((await get()).json().asset).toMatchObject({can_redeem:false,status:'expired',remaining_sessions:0});
 const listing=await app.inject({url:'/v1/desk/packages'});expect(listing.json().userPackages.find((p:{id:string})=>p.id===order.assetId)).toMatchObject({totalUnits:0,remainingUnits:0,canRedeem:false});
 const first=await run<{refundId:string}>('commerce.requestRefund',{paymentId:order.paymentId,amountCents:20000,reason:'Manual unused validity refund after expiry',unlimitedTerminationConfirmed:true});
 await run('commerce.confirmOfflineRefund',{refundId:first.refundId,reference:'QA first unlimited cash return'});
 await expect(run('commerce.requestRefund',{paymentId:order.paymentId,amountCents:30001,reason:'Exceeds original payment'})).rejects.toMatchObject({details:{reason:'refund_exceeds_payment'}});
 const second=await run<{refundId:string}>('commerce.requestRefund',{paymentId:order.paymentId,amountCents:30000,reason:'Approved remaining refund',unlimitedTerminationConfirmed:true});
 const key=randomUUID(),confirmation={refundId:second.refundId,reference:'QA remaining unlimited cash return'};await run('commerce.confirmOfflineRefund',confirmation,key);await run('commerce.confirmOfflineRefund',confirmation,key);
 const [facts]=await withTenant(ctx,tx=>tx`select cp.status,cp.remaining_sessions,cp.refund_frozen,(select count(*)::int from customer_package_ledger where package_id=cp.id and entry='redeem') as uses,(select sum(value_cents)::int from customer_package_ledger where package_id=cp.id and entry='purchase_refund') as returned_value,(select sum(amount_cents)::int from commerce_refunds where payment_id=${order.paymentId} and status='succeeded') as cash_returned from customer_packages cp where cp.id=${order.assetId}`);
 expect(facts).toMatchObject({status:'void',remaining_sessions:0,refund_frozen:false,uses:1,returned_value:-50000,cash_returned:50000});
 await expect(run('package.redeem',{packageId:order.assetId,customerId,units:1})).rejects.toMatchObject({details:{reason:'package_not_active'}});
},15000);
