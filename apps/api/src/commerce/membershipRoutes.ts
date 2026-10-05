import {customerFamilies} from '../customerIdentity';
import {z} from 'zod';
import {withTenant} from '@gf/db';
import {AppError,ERROR_CODES,pickText,membershipEnrollmentInput,membershipChangeInput,membershipChangeWithdrawalInput} from '@gf/contracts';
import type {FastifyInstance} from 'fastify';
import {dispatch} from '../bus';
import type {CtxFromHeaders} from '../routes/utils';
import {resolveHostedShop,publicContext} from '../public/publicAuth';
import {checkRateLimits} from '../public/rateLimit';
import {hashManageToken,unwrapManageToken} from '../public/bookingToken';
import {commerceEnabled,commerceLiveMode} from './config';
import {runCommerceTask} from './worker';
import {createMembershipPortal,reconcileMembership} from './customerMembership';
import type {CustomerMembershipTerms} from '@gf/contracts';
import '../handlers/customerMembership';
import '../handlers/membershipChanges';
import {membershipTerminationReview} from '../handlers/membershipTermination';
export function registerMembershipRoutes(app:FastifyInstance,ctxFromHeaders:CtxFromHeaders):void{
 app.get<{Params:{id:string}}>('/v1/desk/commerce/memberships/:id/termination-review',async(req,reply)=>{
  reply.header('cache-control','private, no-store');const ctx=await ctxFromHeaders(req);
  if(!ctx.permissions.has('commerce.refund'))throw new AppError(ERROR_CODES.PERMISSION_DENIED);
  const id=z.string().uuid().parse(req.params.id);
  return withTenant(ctx,async tx=>{const review=await membershipTerminationReview(tx,ctx,id),{m,...rest}=review;
   return {...rest,membership:{id:m.id,providerStatus:m.provider_status,name:pickText(m.snapshot.terms.name,ctx.locale),currency:m.snapshot.currency,timezone:m.snapshot.timezone}};});
 });
 app.get<{Params:{id:string}}>('/v1/desk/commerce/memberships/:id/access-review',async(req,reply)=>{
  reply.header('cache-control','private, no-store');const ctx=await ctxFromHeaders(req);if(!ctx.permissions.has('commerce.configure'))throw new AppError(ERROR_CODES.PERMISSION_DENIED);
  const id=z.string().uuid().parse(req.params.id);
  return withTenant(ctx,async tx=>{const [row]=await tx`select m.id,c.display_name as name,original.email,m.manage_access_version as version,m.manage_token_expires_at as expires_at,m.manage_token_revoked_at is not null as revoked from customer_paid_memberships m join customers original on original.id=m.customer_id join ${customerFamilies(tx)}f on f.id=m.customer_id join customers c on c.id=f.root_id where m.id=${id}`;if(!row)throw new AppError(ERROR_CODES.NOT_FOUND);return row;});
 });
 app.get('/v1/desk/commerce/memberships',async(req,reply)=>{
  reply.header('cache-control','private, no-store');const ctx=await ctxFromHeaders(req);
  if(!ctx.permissions.has('commerce.read'))throw new AppError(ERROR_CODES.PERMISSION_DENIED);
  return withTenant(ctx,async tx=>{
   const versions=await tx<{id:string;version_id:string;version:number;terms:CustomerMembershipTerms;currency:string;active:boolean;online_sale:boolean}[]>`
    select p.id,p.active,p.online_sale,v.id as version_id,v.version,v.terms,v.currency from customer_membership_plans p
    join lateral(select * from customer_membership_plan_versions where plan_id=p.id order by version desc limit 1)v on true order by p.created_at,p.id`;
   const services=await tx<{id:string;name:unknown}[]>`select id,name from services where location_id=${ctx.locationId} and active order by sort,id`;
   const members=await tx`select m.id,m.provider_status,m.cancel_at_period_end,m.current_period_end,m.commerce_frozen,c.display_name,m.customer_id as original_customer_id,f.root_id as customer_id,
    coalesce((select snapshot from customer_membership_plan_changes where membership_id=m.id and stripe_price_id=m.current_price_id and status in('scheduled','applied') order by effective_at desc limit 1),m.snapshot) as snapshot,
    (select jsonb_build_object('status',status,'withdrawalRequested',withdrawal_requested_at is not null,'effectiveAt',effective_at,'snapshot',snapshot) from customer_membership_plan_changes where membership_id=m.id and status in('pending','scheduled') order by effective_at desc limit 1) as next_change,
    m.created_at,(select count(*)::int from customer_membership_invoices i where i.membership_id=m.id) as paid_invoices,
    (select coalesce(sum(upper(r)-lower(r)),0)::int from customer_membership_cycles b cross join lateral unnest(b.available_units)r
     where b.membership_id=m.id and b.status='issued' and b.starts_at<=now() and b.ends_at>now() and not m.commerce_frozen and m.terminated_at is null) as available_quantity
    from customer_paid_memberships m join ${customerFamilies(tx)}f on f.id=m.customer_id join customers c on c.id=f.root_id order by m.created_at desc limit 100`;
   return {plans:versions,services:services.map(s=>({id:s.id,name:pickText(s.name,ctx.locale)})),members};
  });
 });
 const path='/v1/public/shops/:slug/commerce/memberships';
 async function shop(slug:string,locale='en',ip?:string){const s=await resolveHostedShop(slug);return {shop:s,ctx:publicContext(s,locale,ip)};}
 app.get<{Params:{slug:string};Querystring:{locale?:string}}>(path,async(req,reply)=>{
  reply.header('cache-control','no-store');const {shop:s,ctx}=await shop(req.params.slug,req.query.locale);
  return withTenant(ctx,async tx=>{
   const [location]=await tx<{currency:string;timezone:string;settings:{commerce?:{salesEnabled?:boolean;membershipsEnabled?:boolean}}}[]>`select currency,timezone,settings from locations where id=${ctx.locationId}`;
   const [a]=await tx<{charges_enabled:boolean;disconnected:boolean;capabilities:Record<string,string>}[]>`select * from commerce_accounts where location_id=${ctx.locationId} and livemode=${commerceLiveMode()}`;
   const plans=await tx<{id:string;version_id:string;terms:CustomerMembershipTerms;currency:string}[]>`select p.id,v.id as version_id,v.terms,v.currency
    from customer_membership_plans p join lateral(select * from customer_membership_plan_versions where plan_id=p.id order by version desc limit 1)v on true
    where p.active and p.online_sale order by p.created_at,p.id`;
   const services=await tx<{id:string;name:unknown}[]>`select id,name from services where location_id=${ctx.locationId} and active order by sort,id`;
   return {shopName:pickText(s.name,ctx.locale),currency:location!.currency,timezone:location!.timezone,services:services.map(x=>({id:x.id,name:pickText(x.name,ctx.locale)})),
    available:!!(commerceEnabled()&&location?.settings.commerce?.membershipsEnabled&&a?.charges_enabled&&!a.disconnected&&a.capabilities.card_payments==='active'),
    plans:plans.map(p=>({id:p.id,versionId:p.version_id,name:pickText(p.terms.name,ctx.locale),terms:p.terms,currency:p.currency}))};
  });
 });
 app.post<{Params:{slug:string}}>(path,async(req,reply)=>{
  reply.header('cache-control','no-store');const rate=await checkRateLimits([{scope:'membership-enroll',id:req.ip,limit:10,windowSec:600}],app.log);
  if(!rate.ok)return reply.status(429).send({code:'RATE_LIMITED'});
  // The enrollment schema refines the consent version, so parse the locale separately.
  const raw=z.object({locale:z.string().optional()}).passthrough().parse(req.body);
  const input=membershipEnrollmentInput.parse(raw),{ctx}=await shop(req.params.slug,raw.locale,req.ip);
  const result=await dispatch<{membershipId:string;orderId:string}>('commerce.enrollMembership',input,ctx,
   {systemOrigin:'commerce_public_membership',idempotencyKey:`membership-enroll:${input.businessKey}`});
  const [m]=await withTenant(ctx,tx=>tx<{manage_token_hash:string;manage_token_wrapped:Buffer;id:string}[]>`select id,manage_token_hash,manage_token_wrapped from customer_paid_memberships where id=${result.result.membershipId}`);
  const token=m?unwrapManageToken(m.manage_token_wrapped,m.manage_token_hash):null;if(!token)throw new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE);
  const [task]=await withTenant(ctx,tx=>tx<{id:string}[]>`select id from commerce_tasks where kind='checkout' and subject_id=${result.result.orderId}`);
  if(task)await runCommerceTask(ctx,task.id);
  const [p]=await withTenant(ctx,tx=>tx<{checkout_url:string|null}[]>`select checkout_url from commerce_payments where order_id=${result.result.orderId}`);
  return {...result.result,token,url:p?.checkout_url??null};
 });
 app.post<{Params:{slug:string;id:string}}>(`${path}/:id/plan-change`,async(req,reply)=>{
  reply.header('cache-control','no-store');const rate=await checkRateLimits([{scope:'membership-change',id:req.ip,limit:10,windowSec:600}],app.log);if(!rate.ok)return reply.status(429).send({code:'RATE_LIMITED'});
  const id=z.string().uuid().parse(req.params.id),token=z.string().regex(/^cm_[A-Za-z0-9_-]{43}$/).parse(req.headers['x-gf-commerce-token']);
  const raw=membershipChangeInput.extend({locale:z.enum(['en','zh-Hans','zh-Hant','es','ko','vi']).default('en')}).strict().parse(req.body),{locale,...input}=raw;
  const {ctx}=await shop(req.params.slug,locale,req.ip),tokenHash=hashManageToken(token);
  const [m]=await withTenant(ctx,tx=>tx<{original_order_id:string}[]>`select original_order_id from customer_paid_memberships where id=${id} and manage_token_hash=${tokenHash} and manage_token_revoked_at is null and manage_token_expires_at>now()`);
  if(!m)throw new AppError(ERROR_CODES.NOT_FOUND);
  const recoveryKey=`membership-change:${id}:${input.businessKey}`;
  const [known]=await withTenant(ctx,tx=>tx`select key from command_idempotency where location_id=${ctx.locationId} and key=${recoveryKey} and command='commerce.requestMembershipChange'`);
  if(!known)await reconcileMembership(ctx,m.original_order_id);
  const result=await dispatch<{changeId:string;status:string}>('commerce.requestMembershipChange',{...input,membershipId:id,tokenHash},ctx,
   {systemOrigin:'commerce_customer_membership_change',idempotencyKey:recoveryKey});
  const [task]=await withTenant(ctx,tx=>tx<{id:string}[]>`select id from commerce_tasks where kind='membership_change' and subject_id=${result.result.changeId}`);if(task&&!result.replayed)await runCommerceTask(ctx,task.id);
  const [change]=await withTenant(ctx,tx=>tx<{status:string}[]>`select status from customer_membership_plan_changes where id=${result.result.changeId}`);
  return {changeId:result.result.changeId,status:change!.status,replayed:result.replayed};
 });
 app.post<{Params:{slug:string;id:string;changeId:string}}>(`${path}/:id/plan-change/:changeId/withdraw`,async(req,reply)=>{
  reply.header('cache-control','no-store');const rate=await checkRateLimits([{scope:'membership-withdrawal',id:req.ip,limit:10,windowSec:600}],app.log);if(!rate.ok)return reply.status(429).send({code:'RATE_LIMITED'});
  const id=z.string().uuid().parse(req.params.id),changeId=z.string().uuid().parse(req.params.changeId),token=z.string().regex(/^cm_[A-Za-z0-9_-]{43}$/).parse(req.headers['x-gf-commerce-token']);
  const raw=membershipChangeWithdrawalInput.extend({locale:z.enum(['en','zh-Hans','zh-Hant','es','ko','vi']).default('en')}).strict().parse(req.body),{locale,...input}=raw;
  const {ctx}=await shop(req.params.slug,locale,req.ip);
  const result=await dispatch<{changeId:string;status:string}>('commerce.withdrawMembershipChange',{...input,membershipId:id,changeId,tokenHash:hashManageToken(token)},ctx,
   {systemOrigin:'commerce_customer_membership_withdrawal',idempotencyKey:`membership-withdrawal:${id}:${input.businessKey}`});
  const [task]=await withTenant(ctx,tx=>tx`select id from commerce_tasks where kind='membership_change_withdraw' and subject_id=${changeId}`);
  if(task&&!result.replayed)await runCommerceTask(ctx,task.id);
  const [change]=await withTenant(ctx,tx=>tx`select status from customer_membership_plan_changes where id=${changeId}`);
  return {changeId,status:['withdrawn','applied','canceled'].includes(change!.status)?change!.status:'withdrawing',replayed:result.replayed};
 });
 app.get<{Params:{slug:string;id:string}}>(`${path}/:id`,async(req,reply)=>{
  reply.header('cache-control','no-store');const rate=await checkRateLimits([{scope:'membership-query',id:req.ip,limit:60,windowSec:60}],app.log);
  if(!rate.ok)return reply.status(429).send({code:'RATE_LIMITED'});
  const id=z.string().uuid().parse(req.params.id),token=z.string().regex(/^cm_[A-Za-z0-9_-]{43}$/).parse(req.headers['x-gf-commerce-token']);
  const {ctx}=await shop(req.params.slug);
  return withTenant(ctx,async tx=>{
   const [m]=await tx<{id:string;provider_status:string;current_period_end:Date|null;cancel_at_period_end:boolean;scheduled_cancel_at:string|null;commerce_frozen:boolean;terminated_at:Date|null;snapshot:unknown;original_order_id:string;account_id:string;stripe_customer_id:string|null;stripe_subscription_id:string|null;current_price_id:string|null}[]>`
    select id,provider_status,current_period_end,cancel_at_period_end,scheduled_cancel_at,commerce_frozen,terminated_at,snapshot,original_order_id,account_id,stripe_customer_id,stripe_subscription_id,current_price_id from customer_paid_memberships
    where id=${id} and manage_token_hash=${hashManageToken(token)} and manage_token_revoked_at is null and manage_token_expires_at>now()`;
   if(!m)throw new AppError(ERROR_CODES.NOT_FOUND);
   const cycles=await tx`select b.id,b.cycle_index,b.starts_at,b.ends_at,b.quantity,b.status,i.snapshot,i.plan_version_id,
    case when b.status='issued' and b.starts_at<=now() and b.ends_at>now() and not ${m.commerce_frozen} and ${m.terminated_at}::timestamptz is null
     then (select coalesce(sum(upper(r)-lower(r)),0)::int from unnest(b.available_units)r) else 0 end as available_quantity,
    b.value_cents from customer_membership_cycles b join customer_membership_invoices i on i.id=b.invoice_id where b.membership_id=${id} order by b.starts_at,b.id`;
   const invoices=await tx`select i.id,i.period_start,i.period_end,i.paid_at,i.snapshot,i.plan_version_id,p.amount_cents,p.currency,p.status,
    (select coalesce(sum(r.amount_cents),0)::int from commerce_refunds r where r.payment_id=p.id and r.status='succeeded') as refunded_cents,
    (select coalesce(sum(r.amount_cents),0)::int from commerce_refunds r where r.payment_id=p.id and r.status in('pending','review')) as pending_refund_cents,
    exists(select 1 from commerce_refunds r where r.payment_id=p.id and r.status='failed') as refund_failed from customer_membership_invoices i
    join commerce_payments p on p.id=i.payment_id where i.membership_id=${id} order by i.period_start desc`;
   const [p]=await tx<{checkout_url:string|null;status:string}[]>`select checkout_url,status from commerce_payments where order_id=${m.original_order_id}`;
   const [location]=await tx<{timezone:string}[]>`select timezone from locations where id=${ctx.locationId}`;
   const [account]=await tx<{disconnected:boolean}[]>`select disconnected from commerce_accounts where id=${m.account_id}`;
   const {account_id,stripe_customer_id,stripe_subscription_id,current_price_id,...publicMember}=m;
   const planChanges=await tx`select c.id,c.status,c.effective_at,c.snapshot,c.plan_version_id,c.withdrawal_requested_at,c.withdrawn_at,t.status as task_status,wt.status as withdrawal_task_status from customer_membership_plan_changes c
    left join commerce_tasks t on t.kind='membership_change' and t.subject_id=c.id left join commerce_tasks wt on wt.kind='membership_change_withdraw' and wt.subject_id=c.id where c.membership_id=${m.id} order by c.effective_at desc,c.id`;
   const [billing]=await tx<{snapshot:unknown}[]>`select snapshot from customer_membership_plan_changes where membership_id=${m.id} and stripe_price_id=${current_price_id} and status in('scheduled','applied') order by effective_at desc limit 1`;
   const [benefitContract]=await tx<{snapshot:unknown}[]>`select i.snapshot from customer_membership_cycles c join customer_membership_invoices i on i.id=c.invoice_id where c.membership_id=${m.id} and c.status='issued' and c.starts_at<=now() and c.ends_at>now() and not ${m.commerce_frozen} and ${m.terminated_at}::timestamptz is null order by c.starts_at desc limit 1`;
   const ledger=await tx`select l.id,l.entry,l.quantity,l.business_date,l.created_at,case when l.entry='stop' then c.quantity else 0 end as planned_quantity from customer_membership_ledger l
    join customer_membership_cycles c on c.id=l.cycle_id where c.membership_id=${m.id} and l.entry in('issue','redeem','restore','expire','stop','revoke') order by l.created_at desc,l.id desc limit 100`;
   const [termination]=await tx`select status,unused_benefits,provider_canceled_at from customer_membership_terminations where membership_id=${m.id}`;
   const [benefits]=await tx<{active:boolean}[]>`select exists(select 1 from customer_membership_cycles c where c.membership_id=${m.id}
    and c.status='issued' and c.starts_at<=now() and c.ends_at>now() and not ${m.commerce_frozen} and ${m.terminated_at}::timestamptz is null) as active`;
   return {membership:publicMember,billingSnapshot:billing?.snapshot??m.snapshot,benefitSnapshot:benefitContract?.snapshot??null,planChanges,cycles,invoices,ledger,termination:termination??null,benefitsActive:benefits!.active,timezone:location!.timezone,checkoutUrl:p?.status==='pending'?p.checkout_url:null,
    accountDisconnected:account?.disconnected??true,portalAvailable:!!(stripe_customer_id&&stripe_subscription_id&&!m.commerce_frozen&&!account?.disconnected)};
  });
 });
 app.post<{Params:{slug:string;id:string}}>(`${path}/:id/portal`,async(req,reply)=>{
  reply.header('cache-control','no-store');const rate=await checkRateLimits([{scope:'membership-portal',id:req.ip,limit:10,windowSec:600}],app.log);
  if(!rate.ok)return reply.status(429).send({code:'RATE_LIMITED'});
  const id=z.string().uuid().parse(req.params.id),token=z.string().regex(/^cm_[A-Za-z0-9_-]{43}$/).parse(req.headers['x-gf-commerce-token']);
  const input=z.object({locale:z.enum(['en','zh-Hans','zh-Hant','es','ko','vi']).default('en'),businessKey:z.string().uuid()}).strict().parse(req.body);
  const {ctx}=await shop(req.params.slug,input.locale,req.ip);
  await dispatch('commerce.authorizeMembershipPortal',{membershipId:id,tokenHash:hashManageToken(token)},ctx,
   {systemOrigin:'commerce_customer_membership_portal',idempotencyKey:`membership-portal-authorize:${id}:${input.businessKey}`});
  return {url:await createMembershipPortal(ctx,id,input.locale,input.businessKey,hashManageToken(token))};
 });
}
