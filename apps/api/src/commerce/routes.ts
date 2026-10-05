import { createHash,randomBytes,randomUUID } from 'node:crypto';
import { z } from 'zod';
import type Stripe from 'stripe';
import QRCode from 'qrcode';
import type { FastifyInstance } from 'fastify';
import { AppError,ERROR_CODES,pickText,commercePurchaseInput,type Permission } from '@gf/contracts';
import { withTenant } from '@gf/db';
import { dispatch } from '../bus';
import type { CtxFromHeaders } from '../routes/utils';
import { rawBodyOf } from '../rawBody';
import { verifyStripeSignature } from '../stripe/verify';
import {commerceStripeClient as stripeClient} from './client';
import { resolveHostedShop,publicContext } from '../public/publicAuth';
import { checkRateLimits } from '../public/rateLimit';
import { assertCommerceEnabled,commerceEnabled,commerceLiveMode } from './config';
import { commerceReturnBase } from './provider';
import { processCommerceEvent,processCommerceAccountEvent,reconcileCheckout } from './webhook';
import { accountIncludes,newMerchantParams,refreshCommerceAccount,saveVerifiedV2Account,merchantOnboardingLink,type CommerceAccountMapping } from './accounts';
import { runCommerceTask } from './worker';
import type { Ctx } from './model';
import { normalizeCardCode } from '@gf/payroll';
import {registerMembershipRoutes} from './membershipRoutes';
import {purchaseQuoteHash} from './purchaseQuote';
import '../handlers/commercePayouts';

function requirePermission(ctx:Ctx,permission:Permission) {if(!ctx.permissions.has(permission))throw new AppError(ERROR_CODES.PERMISSION_DENIED,{details:{need:permission}});}
const keyInput=z.object({idempotencyKey:z.string().min(8).max(160)});
async function purchaseToken(ctx:Ctx,orderId:string) {
  const token=randomBytes(32).toString('base64url');
  const tokenHash=createHash('sha256').update(token).digest('hex');
  await dispatch('commerce.issueAccess',{orderId,tokenHash},ctx,{systemOrigin:'commerce_order_creator',idempotencyKey:`commerce-access:${randomUUID()}`});
  return token;
}
export function registerCommerceRoutes(app:FastifyInstance,ctxFromHeaders:CtxFromHeaders) {
  registerMembershipRoutes(app,ctxFromHeaders);
  app.get('/v1/desk/commerce/payouts',async(req,reply)=>{
    reply.header('cache-control','private, no-store');const ctx=await ctxFromHeaders(req);requirePermission(ctx,'report.view');requirePermission(ctx,'commerce.read');
    return withTenant(ctx,async tx=>{
      const payouts=await tx`select p.id,p.amount_cents,p.currency,p.automatic,p.livemode,p.provider_created_at,p.business_date,
        o.status,o.arrival_at,o.failure_code,o.source_count,o.source_net_cents,
        (select coalesce(sum(t.net_cents),0)::int from commerce_payout_transactions t where t.payout_id=p.id and role='debit') as debit_net_cents,
        (select coalesce(sum(t.net_cents),0)::int from commerce_payout_transactions t where t.payout_id=p.id and role='reversal') as returned_net_cents,
        exists(select 1 from commerce_payout_transactions t where t.payout_id=p.id and role='debit') as debit_verified,
        exists(select 1 from commerce_payout_transactions t where t.payout_id=p.id and role='reversal') as return_verified
        from commerce_payouts p join lateral(select * from commerce_payout_observations where payout_id=p.id order by observed_at desc,created_at desc,id desc limit 1)o on true
        order by p.provider_created_at desc,p.id desc limit 100`;
      const sources=await tx`select t.payout_id,t.gross_cents,t.fee_cents,t.net_cents,t.currency,t.type,o.kind as purchase_kind,
        p.id as payment_id,r.id as refund_id from commerce_payout_transactions t
        left join commerce_payments p on p.balance_transaction_id=t.balance_transaction_id
        left join commerce_orders o on o.id=p.order_id
        left join commerce_refunds r on r.balance_transaction_id=t.balance_transaction_id
        where t.role='source' and t.payout_id=any(${payouts.map(p=>p.id)}::uuid[]) order by t.provider_created_at,t.id`;
      return {payouts,sources};
    });
  });
  app.post('/v1/stripe/commerce-webhook',async(req)=>{
    const secret=process.env.STRIPE_COMMERCE_WEBHOOK_SECRET;
    if(!secret)throw new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE,{details:{reason:'commerce_webhook_unconfigured'}});
    const raw=rawBodyOf(req);
    verifyStripeSignature({rawBody:raw,signatureHeader:typeof req.headers['stripe-signature']==='string'?req.headers['stripe-signature']:undefined,webhookSecret:secret});
    const event=JSON.parse(raw) as Stripe.Event;
    return {received:true,result:await processCommerceEvent(event)};
  });
  app.post('/v1/stripe/commerce-account-webhook',async(req)=>{
    const secret=process.env.STRIPE_COMMERCE_ACCOUNT_WEBHOOK_SECRET;
    if(!secret)throw new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE,{details:{reason:'commerce_account_webhook_unconfigured'}});
    const raw=rawBodyOf(req);
    verifyStripeSignature({rawBody:raw,signatureHeader:typeof req.headers['stripe-signature']==='string'?req.headers['stripe-signature']:undefined,webhookSecret:secret});
    return {received:true,result:await processCommerceAccountEvent(JSON.parse(raw))};
  });
  app.get('/v1/desk/commerce',async(req,reply)=>{
    reply.header('cache-control','private, no-store');
    const ctx=await ctxFromHeaders(req);requirePermission(ctx,'commerce.read');
    return withTenant(ctx,async tx=>{
      const accounts=await tx`select id,stripe_account_id,api_version,livemode,charges_enabled,payouts_enabled,details_submitted,disconnected,requirements,refreshed_at
        from commerce_accounts where location_id=${ctx.locationId}`;
      const orders=await tx`select o.id,o.kind,o.channel,o.status,o.amount_cents,o.currency,o.asset_id,o.created_at,
        o.snapshot->>'name' as name,(o.kind='package' and (o.snapshot->>'sessions')::integer=0) as unlimited_package,c.display_name as customer_name,p.id as payment_id,p.status as payment_status,
        p.checkout_url,p.paid_at,p.settlement_currency,p.settlement_gross_cents,p.fee_cents,p.net_cents,p.available_on,
        (o.kind='gift_card' and exists(select 1 from customer_credit_ledger x where x.subject_id=o.asset_id and x.kind='gift_card' and x.entry='adjust' and x.amount_cents>0)) as refund_requires_review,
        (select coalesce(sum(amount_cents),0)::int from commerce_refunds r where r.payment_id=p.id and r.status='succeeded') as refunded_cents
        from commerce_orders o left join customers c on c.id=o.customer_id left join commerce_payments p on p.order_id=o.id
        where o.location_id=${ctx.locationId} order by o.created_at desc limit 100`;
      const failedTasks=await tx`select id,kind,subject_id,attempts,last_error from commerce_tasks where location_id=${ctx.locationId} and status='review' order by created_at`;
      const reviewItems=await tx`select id,payment_id,kind,external_id,amount_cents,currency,status,provider_status,created_at
        from commerce_review_items where location_id=${ctx.locationId} and status in ('open','lost','review') order by created_at desc`;
      const refunds=await tx`select r.id,r.payment_id,r.status,r.amount_cents,r.reason,r.external_reference,r.created_at,p.provider,p.currency,
        r.review_required,r.guest_cancellation_id,r.deposit_guest_allocation
        from commerce_refunds r join commerce_payments p on p.id=r.payment_id where r.location_id=${ctx.locationId} order by r.created_at desc limit 100`;
      const deliveries=await tx`select id,commerce_order_id as order_id,entity_type,status,attempts,created_at,sent_at from email_outbox
        where location_id=${ctx.locationId} and commerce_order_id is not null order by created_at desc limit 100`;
      const [location]=await tx<{settings:Record<string,unknown>}[]>`select settings from locations where id=${ctx.locationId}`;
      const gifts=await tx<{id:string;name:Record<string,string>;face_value_cents:number;sale_price_cents:number;valid_days:number|null;scope:'location'|'org';online_sale:boolean;active:boolean}[]>`
        select id,name,face_value_cents,sale_price_cents,valid_days,scope,online_sale,active from gift_card_templates where location_id=${ctx.locationId} order by sort,id`;
      const giftTemplates=gifts.map(g=>({...g,names:g.name,name:pickText(g.name,ctx.locale)}));
      return {enabled:commerceEnabled(),settings:location?.settings.commerce??{salesEnabled:false,depositsEnabled:false,membershipsEnabled:false},accounts,orders,refunds,reviewItems,failedTasks,giftTemplates,deliveries};
    });
  });
  app.post('/v1/commerce/accounts/onboard',async(req)=>{
    const ctx=await ctxFromHeaders(req);requirePermission(ctx,'commerce.configure');assertCommerceEnabled();
    const {idempotencyKey}=keyInput.parse(req.body);const mode=commerceLiveMode();const stripe=stripeClient();
    const [existing]=await withTenant(ctx,tx=>tx<CommerceAccountMapping[]>`select stripe_account_id,api_version from commerce_accounts where location_id=${ctx.locationId} and livemode=${mode}`);
    let mapping:CommerceAccountMapping;
    if(existing){mapping=existing;await refreshCommerceAccount(ctx,mapping,mode,`${idempotencyKey}:${randomUUID()}`);}
    else {
      const account=await stripe.v2.core.accounts.create(newMerchantParams(ctx),{idempotencyKey:`gf-commerce-account-v2:${ctx.locationId}:${mode}`});
      // Stripe's idempotent create response may predate completed onboarding after a DB retry.
      await saveVerifiedV2Account(ctx,await stripe.v2.core.accounts.retrieve(account.id,{include:accountIncludes}),mode,`${idempotencyKey}:${randomUUID()}`);
      mapping={stripe_account_id:account.id,api_version:'v2'};
    }
    const [loc]=await withTenant(ctx,tx=>tx<{slug:string}[]>`select slug from locations where id=${ctx.locationId}`);
    const deskBase=process.env.APP_BASE_URL;
    if(!deskBase)throw new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE,{details:{reason:'APP_BASE_URL_required'}});
    const returnUrl=new URL('/commerce',deskBase);if(returnUrl.protocol!=='https:'&&!['localhost','127.0.0.1'].includes(returnUrl.hostname))throw new AppError(ERROR_CODES.VALIDATION_FAILED);
    const refreshUrl=new URL(returnUrl);refreshUrl.searchParams.set('connect','refresh');
    const link=await merchantOnboardingLink(mapping,returnUrl.href,refreshUrl.href);
    return {url:link.url,accountId:mapping.stripe_account_id,shopSlug:loc?.slug};
  });
  app.get<{Params:{id:string}}>('/v1/desk/commerce/orders/:id',async(req,reply)=>{
    const ctx=await ctxFromHeaders(req);requirePermission(ctx,'commerce.sell');reply.header('cache-control','private, no-store');
    const id=z.string().uuid().parse(req.params.id);
    return withTenant(ctx,async tx=>{
      const [order]=await tx<{id:string;kind:string;status:string;asset_id:string|null;currency:string}[]>`select id,kind,status,asset_id,currency
        from commerce_orders where id=${id} and location_id=${ctx.locationId}`;
      if(!order)throw new AppError(ERROR_CODES.NOT_FOUND);
      let asset:unknown=null;
      if(order.asset_id&&order.kind==='gift_card') {
        const [g]=await tx<{code:string;balance_cents:number;reserved_cents:number;commerce_frozen:boolean;credential_disabled:boolean;status:string}[]>`select code,balance_cents,reserved_cents,commerce_frozen,credential_disabled,status from gift_cards where id=${order.asset_id}`;
        if(g)asset={code:g.credential_disabled?null:g.code,balanceCents:g.commerce_frozen||g.credential_disabled?0:Math.max(0,g.balance_cents-g.reserved_cents),status:g.credential_disabled?'disabled':g.status,qr:g.credential_disabled?null:await QRCode.toDataURL(g.code,{margin:1,width:200})};
      }
      return {order,asset};
    });
  });
  app.get<{Params:{kind:string;id:string};Querystring:{offset?:string}}>('/v1/desk/commerce/assets/:kind/:id',async(req,reply)=>{
    const ctx=await ctxFromHeaders(req);requirePermission(ctx,'commerce.read');reply.header('cache-control','private, no-store');
    const kind=z.enum(['gift_card','package']).parse(req.params.kind),id=z.string().uuid().parse(req.params.id);
    const offset=z.coerce.number().int().min(0).max(10_000_000).default(0).parse(req.query.offset);
    return withTenant(ctx,async tx=>{
      if(kind==='gift_card'){
        const [g]=await tx`select g.id,g.status,g.credential_disabled,g.credential_version,g.commerce_frozen,g.reserved_cents,g.balance_cents,g.expires_at,
          g.purchase_order_id as order_id,l.currency,coalesce(g.purchase_snapshot->>'name','') as name,
          case when ${ctx.permissions.has('commerce.sell')} and not g.credential_disabled then g.code else null end as code
          from gift_cards g join locations l on l.id=g.location_id where g.id=${id} and (g.location_id=${ctx.locationId} or g.scope='org')`;
        if(!g)throw new AppError(ERROR_CODES.NOT_FOUND);
        const ledger=await tx`select id,entry,amount_cents as value_cents,unit,reason,ticket_id,created_at from customer_credit_ledger
          where kind='gift_card' and subject_id=${id} order by seq desc limit 201 offset ${offset}`;
        return {asset:{...g,qr:typeof g.code==='string'?await QRCode.toDataURL(g.code,{margin:1,width:200}):null},ledger:ledger.slice(0,200),nextOffset:ledger.length>200?offset+200:null};
      }
      const [p]=await tx`select cp.id,cp.status,cp.total_sessions,cp.remaining_sessions,cp.reserved_sessions,cp.refund_frozen,cp.commerce_frozen,cp.expires_at,
        cp.purchase_order_id as order_id,l.currency,coalesce(cp.purchase_snapshot->>'name','') as name
        from customer_packages cp join locations l on l.id=cp.location_id left join package_templates pt on pt.id=cp.template_id
        where cp.id=${id} and (cp.location_id=${ctx.locationId} or coalesce(cp.purchase_snapshot->>'scope',pt.scope)='org')`;
      if(!p)throw new AppError(ERROR_CODES.NOT_FOUND);
      const ledger=await tx`select x.id,x.entry,x.quantity,x.value_cents,x.unit_ranges::text as unit_ranges,x.ticket_id,x.created_at,
        exists(select 1 from customer_package_ledger r where r.reversal_of_id=x.id and r.entry='restore') as restored,
        (x.ticket_id is not null and (t.id is null or t.service_settled_at is not null or t.status in ('closed','refunded'))) as settled_service
        from customer_package_ledger x left join tickets t on t.id=x.ticket_id where x.package_id=${id} order by x.seq desc limit 201 offset ${offset}`;
      return {asset:p,ledger:ledger.slice(0,200),nextOffset:ledger.length>200?offset+200:null};
    });
  });
  app.post('/v1/commerce/accounts/refresh',async(req)=>{
    const ctx=await ctxFromHeaders(req);requirePermission(ctx,'commerce.configure');assertCommerceEnabled();
    const {idempotencyKey}=keyInput.parse(req.body);const mode=commerceLiveMode();
    const [existing]=await withTenant(ctx,tx=>tx<CommerceAccountMapping[]>`select stripe_account_id,api_version from commerce_accounts where location_id=${ctx.locationId} and livemode=${mode}`);
    if(!existing)throw new AppError(ERROR_CODES.NOT_FOUND);
    return refreshCommerceAccount(ctx,existing,mode,`${idempotencyKey}:${randomUUID()}`);
  });
  app.post<{Params:{id:string}}>('/v1/commerce/orders/:id/checkout',async(req)=>{
    const ctx=await ctxFromHeaders(req);requirePermission(ctx,'commerce.sell');const id=z.string().uuid().parse(req.params.id);
    const [task]=await withTenant(ctx,tx=>tx<{id:string}[]>`select id from commerce_tasks where subject_id=${id} and kind='checkout'`);
    if(task)await runCommerceTask(ctx,task.id);
    return withTenant(ctx,async tx=>{const [p]=await tx<{checkout_url:string|null}[]>`select checkout_url from commerce_payments where order_id=${id}`;return {url:p?.checkout_url??null};});
  });
  app.post<{Params:{id:string}}>('/v1/commerce/orders/:id/reconcile',async(req)=>{
    const ctx=await ctxFromHeaders(req);requirePermission(ctx,'commerce.read');const id=z.string().uuid().parse(req.params.id);
    return {result:await reconcileCheckout(ctx,id)};
  });

  async function publicShop(slug:string,locale='en',ip?:string) {const shop=await resolveHostedShop(slug);return {shop,ctx:publicContext(shop,locale,ip)};}
  app.post<{Params:{slug:string}}>('/v1/public/shops/:slug/commerce/gift-balance',async(req,reply)=>{
    reply.header('cache-control','no-store');
    const verdict=await checkRateLimits([{scope:'commerce-gift-query',id:req.ip,limit:15,windowSec:600}],app.log);
    if(!verdict.ok)return reply.status(429).send({code:'RATE_LIMITED',messageKey:'error.RATE_LIMITED'});
    const {code}=z.object({code:z.string().min(20).max(60)}).parse(req.body);
    const {ctx}=await publicShop(req.params.slug);
    return withTenant(ctx,async tx=>{
      const [card]=await tx<{balance_cents:number;status:string;expires_at:Date|null;currency:string;code:string}[]>`select
        case when g.commerce_frozen or g.credential_disabled then 0 else greatest(0,g.balance_cents-g.reserved_cents) end as balance_cents,
        case when g.credential_disabled then 'disabled' when g.commerce_frozen then 'review' when g.expires_at<now() then 'expired' else g.status end as status,
        g.expires_at,l.currency,g.code from gift_cards g join locations l on l.id=g.location_id where replace(g.code,'-','')=${normalizeCardCode(code)}
        and (g.location_id=${ctx.locationId} or g.scope='org')`;
      if(!card)throw new AppError(ERROR_CODES.NOT_FOUND);
      return {balanceCents:['active','depleted'].includes(card.status)?card.balance_cents:0,status:card.status,expiresAt:card.expires_at,currency:card.currency,timezone:ctx.timezone,
        qr:card.status==='disabled'?null:await QRCode.toDataURL(card.code,{margin:1,width:200})};
    });
  });
  app.get<{Params:{slug:string};Querystring:{locale?:string}}>('/v1/public/shops/:slug/commerce',async(req,reply)=>{
    reply.header('cache-control','no-store');
    const {shop,ctx}=await publicShop(req.params.slug,req.query.locale,req.ip);
    return withTenant(ctx,async tx=>{
      const [location]=await tx<{settings:Record<string,unknown>;currency:string}[]>`select settings,currency from locations where id=${ctx.locationId}`;
      const config=(location?.settings.commerce??{}) as {salesEnabled?:boolean};
      const mode=commerceEnabled()?commerceLiveMode():process.env.COMMERCE_STRIPE_MODE==='live';
      const [account]=await tx<{charges_enabled:boolean;disconnected:boolean;capabilities:Record<string,string>}[]>`select * from commerce_accounts where location_id=${ctx.locationId} and livemode=${mode}`;
      const available=commerceEnabled()&&!!config.salesEnabled&&!!account?.charges_enabled&&!account.disconnected&&account.capabilities.card_payments==='active';
      const gifts=await tx<{id:string;name:unknown;face_value_cents:number;sale_price_cents:number;valid_days:number|null;scope:string}[]>`select id,name,face_value_cents,sale_price_cents,valid_days,scope from gift_card_templates
        where location_id=${ctx.locationId} and active and online_sale and sale_price_cents>0 order by sort,id`;
      const packages=await tx<{id:string;name:unknown;price_cents:number;sessions:number;valid_days:number|null;scope:string;service_ids:string[];coverage_mode:string|null}[]>`select id,name,price_cents,sessions,valid_days,scope,service_ids,coverage_mode from package_templates
        where location_id=${ctx.locationId} and active and online_sale and price_cents>0 order by sort,id`;
      const services=await tx<{id:string;name:unknown}[]>`select id,name from services where location_id=${ctx.locationId}`;
      const policy=(location?.settings.checkout??{}) as Record<string,unknown>,currency=location?.currency??'USD';
      return {shopName:pickText(shop.name,ctx.locale),currency,available,
        gifts:gifts.map(g=>({id:g.id,name:pickText(g.name,ctx.locale),faceValueCents:g.face_value_cents,priceCents:g.sale_price_cents,validDays:g.valid_days,scope:g.scope,
          quoteHash:purchaseQuoteHash({kind:'gift_card',templateId:g.id,currency,amountCents:g.sale_price_cents,faceValueCents:g.face_value_cents,sessions:0,validDays:g.valid_days,serviceIds:[],scope:g.scope,coverageMode:'bundle'})})),
        packages:packages.map(p=>{const coverageMode=p.coverage_mode??(policy.packageCoverageMode==='any_included'?'any_included':'bundle');return {
          id:p.id,name:pickText(p.name,ctx.locale),priceCents:p.price_cents,sessions:p.sessions,validDays:p.valid_days,scope:p.scope,coverageMode,
          serviceNames:p.service_ids.map(id=>pickText(services.find(s=>s.id===id)?.name,ctx.locale)),
          quoteHash:purchaseQuoteHash({kind:'package',templateId:p.id,currency,amountCents:p.price_cents,faceValueCents:0,sessions:p.sessions,validDays:p.valid_days,serviceIds:p.service_ids,scope:p.scope,coverageMode})};})};
    });
  });
  app.post<{Params:{slug:string}}>('/v1/public/shops/:slug/commerce/orders',async(req,reply)=>{
    const verdict=await checkRateLimits([{scope:'commerce-purchase',id:req.ip,limit:10,windowSec:600}],app.log);
    if(!verdict.ok)return reply.status(429).send({code:'RATE_LIMITED',messageKey:'error.RATE_LIMITED'});
    const raw=z.object({kind:z.enum(['gift_card','package']),templateId:z.string().uuid(),customer:z.object({name:z.string(),email:z.string().email(),phoneE164:z.string().optional()}),
      businessKey:z.string().min(8).max(160),expectedQuoteHash:z.string().regex(/^[a-f0-9]{64}$/).optional(),locale:z.string().optional(),recipientName:z.string().optional(),recipientNote:z.string().optional(),recipientEmail:z.string().email().optional()}).parse(req.body);
    const {ctx}=await publicShop(req.params.slug,raw.locale,req.ip);
    const input=commercePurchaseInput.parse({...raw,channel:'online'});
    const result=await dispatch<{orderId:string}>('commerce.publicOrder',input,ctx,{systemOrigin:'commerce_public_purchase',idempotencyKey:`commerce-public:${input.businessKey}`});
    const token=await purchaseToken(ctx,result.result.orderId);
    const [task]=await withTenant(ctx,tx=>tx<{id:string}[]>`select id from commerce_tasks where kind='checkout' and subject_id=${result.result.orderId}`);
    if(task)await runCommerceTask(ctx,task.id);
    const [payment]=await withTenant(ctx,tx=>tx<{checkout_url:string|null;status:string}[]>`select checkout_url,status from commerce_payments where order_id=${result.result.orderId}`);
    return {orderId:result.result.orderId,token,url:payment?.status==='pending'?payment.checkout_url:null};
  });
  app.get<{Params:{slug:string;id:string}}>('/v1/public/shops/:slug/commerce/orders/:id',async(req,reply)=>{
    reply.header('cache-control','no-store');
    const verdict=await checkRateLimits([{scope:'commerce-order-query',id:req.ip,limit:60,windowSec:60}],app.log);
    if(!verdict.ok)return reply.status(429).send({code:'RATE_LIMITED',messageKey:'error.RATE_LIMITED'});
    const id=z.string().uuid().parse(req.params.id);const token=z.string().regex(/^[A-Za-z0-9_-]{43}$/).parse(req.headers['x-gf-commerce-token']);
    const {ctx}=await publicShop(req.params.slug);
    return withTenant(ctx,async tx=>{
      const [access]=await tx<{order_id:string}[]>`select order_id from commerce_access_tokens where order_id=${id}
        and token_hash=${createHash('sha256').update(token).digest('hex')} and revoked_at is null and expires_at>now()`;
      if(!access)throw new AppError(ERROR_CODES.NOT_FOUND);
      const [o]=await tx<{id:string;status:string;kind:string;amount_cents:number;currency:string;asset_id:string|null}[]>`select id,status,kind,amount_cents,currency,asset_id from commerce_orders where id=${id}`;
      const [p]=await tx<{checkout_url:string|null;status:string}[]>`select checkout_url,status from commerce_payments where order_id=${id}`;
      let asset:unknown=null;
      if(o?.asset_id&&o.kind==='gift_card') {const [g]=await tx`select case when credential_disabled then null else code end as code,
        case when commerce_frozen or credential_disabled then 0 else greatest(0,balance_cents-reserved_cents) end as balance_cents,face_value_cents,
        case when credential_disabled then 'disabled' when commerce_frozen then 'review' when reserved_cents>0 then 'refund_pending' else status end as status,expires_at from gift_cards where id=${o.asset_id}`;asset=g??null;}
      if(o?.asset_id&&o.kind==='package') {const [g]=await tx`select case when refund_frozen or commerce_frozen or status<>'active' or expires_at<=now() then 0 else greatest(0,remaining_sessions-reserved_sessions) end as remaining_sessions,
        total_sessions,(status='active' and not refund_frozen and not commerce_frozen and (expires_at is null or expires_at>now()) and (total_sessions=0 or remaining_sessions>reserved_sessions)) as can_redeem,
        case when status='void' then status when commerce_frozen then 'review' when refund_frozen then 'refund_pending' when expires_at<=now() then 'expired' else status end as status,expires_at from customer_packages where id=${o.asset_id}`;asset=g??null;}
      const [refunds]=await tx<{refunded:number;pending:number}[]>`select
        coalesce(sum(r.amount_cents) filter(where r.status='succeeded'),0)::int as refunded,
        coalesce(sum(r.amount_cents) filter(where r.status='pending'),0)::int as pending
        from commerce_refunds r join commerce_payments p on p.id=r.payment_id where p.order_id=${id}`;
      return {timezone:ctx.timezone,order:o,paymentStatus:p?.status??'pending',checkoutUrl:p?.checkout_url??null,asset,refundedCents:refunds!.refunded,pendingRefundCents:refunds!.pending};
    });
  });
}
