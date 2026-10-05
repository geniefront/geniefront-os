// Reuses the original $20 sandbox deposit, its $8 retention and $12 completed refund.
import {readFile,writeFile,chmod} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {CommerceReleaseDepositRetention,type CommerceDaySummary} from '../packages/contracts/src/index';
import {commerceFingerprint} from '../packages/payroll/src/index';
import {assertRegressionTarget} from '../packages/db/src/qa/regressionSafety';
for(const [target,source] of [['DATABASE_URL','TEST_DATABASE_URL'],['MIGRATION_DATABASE_URL','TEST_MIGRATION_DATABASE_URL']] as const){const u=new URL(process.env[source]??'');if(u.hostname!=='127.0.0.1'||u.port!=='58332')throw new Error('Preserved local QA only');u.pathname='/gf_commerce_ci';process.env[target]=u.href;}
process.env.NODE_ENV='test';process.env.COMMUNICATION_DELIVERY_MODE='capture';assertRegressionTarget(process.env);
if(process.env.COMMERCE_STRIPE_MODE!=='test'||!['localhost','127.0.0.1'].includes(new URL(process.env.SUPABASE_URL!).hostname))throw new Error('Local sandbox required');
const mode=process.argv[2],session='commerce-release-native',file='/tmp/commerce-release-private.json';
if(!['open','verify-day','reconcile','install-loss','capture-loss','observe-replay','verify','open-customer'].includes(mode??''))throw new Error('Unknown release mode');
const original=JSON.parse(await readFile('/tmp/commerce-retention-browser-private.json','utf8')) as {holdId:string;appointmentId:string;orderId:string;manageToken:string};
const {withTenant,closeDb}=await import('../packages/db/src/index'),tenant={orgId:'22222222-2222-4222-8222-222222222222',locationId:'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',membershipId:null};
const cli='/Users/naiyouzhu/.npm/_npx/6de2aa2fded2970c/node_modules/agent-browser/bin/agent-browser.js';
function browser(args:string[],input?:string){const r=spawnSync(process.execPath,[cli,'--session',session,...args],{encoding:'utf8',...(input?{input}:{})});if(r.status!==0)throw new Error('Owned native browser action failed');return r.stdout.trim();}
function evaluate(code:string){return JSON.parse(browser(['eval','--stdin'],code));}
type State={originalRetentionHash:string;attempt?:{key:string;input:unknown;originalHttpStatus:number}};let state:State|undefined;
try{state=JSON.parse(await readFile(file,'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
async function save(){await writeFile(file,JSON.stringify(state),{mode:0o600});await chmod(file,0o600);}
try{
 const [retention]=await withTenant(tenant,tx=>tx`select r.id,r.amount_cents,md5(row_to_json(r)::text) as hash,p.payment_intent_id,p.stripe_account_id,p.id as payment_id
  from commerce_deposit_retentions r join commerce_payments p on p.id=r.payment_id where r.hold_id=${original.holdId}`);
 if(!retention||retention.amount_cents!==800||retention.stripe_account_id!==process.env.COMMERCE_TEST_ACCOUNT_ID)throw new Error('Original retained sandbox deposit required');
 if(!state){state={originalRetentionHash:retention.hash};await save();}
 if(mode==='reconcile'||mode==='verify-day'){
  const response=await fetch(`${process.env.SUPABASE_URL}/auth/v1/token?grant_type=password`,{method:'POST',headers:{apikey:process.env.SUPABASE_ANON_KEY!,'content-type':'application/json'},body:JSON.stringify({email:'qa-local-owner@example.test',password:process.env.GF_BASELINE_PASSWORD})});if(!response.ok)throw new Error('Existing local owner login failed');const login=await response.json() as {access_token:string;user:{id:string}};
  const [owner]=await withTenant(tenant,tx=>tx`select id from memberships where user_id=${login.user.id} and location_id=${tenant.locationId} and status='active'`);if(!owner)throw new Error('QA owner required');
  const headers={authorization:`Bearer ${login.access_token}`,'x-membership-id':owner.id,'content-type':'application/json'};
  if(mode==='reconcile'){
   const reconciled=await fetch(`http://127.0.0.1:3087/v1/commerce/orders/${original.orderId}/reconcile`,{method:'POST',headers,body:'{}'});if(!reconciled.ok)throw new Error('Original order reconciliation failed');console.log(JSON.stringify({reconciled:true,newPayment:false}));
  }else{
   const [dates]=await withTenant(tenant,tx=>tx`select ((r.created_at at time zone l.timezone)-l.business_day_cutoff)::date::text as retained_day,
    ((s.created_at at time zone l.timezone)-l.business_day_cutoff)::date::text as released_day from commerce_deposit_retentions r join commerce_deposit_retention_releases s on s.retention_id=r.id join locations l on l.id=r.location_id where r.id=${retention.id}`);
   if(!dates||dates.retained_day===dates.released_day)throw new Error('Existing cross-day original release required');const days=[];
   for(const day of [dates.retained_day,dates.released_day]){
    const response=await fetch(`http://127.0.0.1:3087/v1/desk/dayclose?date=${day}`,{headers});if(!response.ok)throw new Error('Actual day-close API required');const data=await response.json() as {money:{commerce:CommerceDaySummary}};
    const [expected]=await withTenant(tenant,tx=>tx`select -coalesce(sum(d.amount_cents),0)::int as retained_net from commerce_deposit_ledger d join locations l on l.id=d.location_id
     where d.location_id=${tenant.locationId} and d.entry in('retained','retention_released') and ((d.created_at at time zone l.timezone)-l.business_day_cutoff)::date=${day}::date`);
    const actual=data.money.commerce.currencies.find(c=>c.currency==='usd');if(!actual||actual.depositRetainedCents!==expected!.retained_net)throw new Error('Cross-day retained/released totals mismatch');days.push({day,retainedNetCents:actual.depositRetainedCents,prepaidOnlineRefundedCents:actual.stripeRefundedCents});
   }
   if(days[0]!.retainedNetCents!==800||days[1]!.retainedNetCents!==-800)throw new Error('Original retained day must remain and current day must reverse it');
   const [notice]=await withTenant(tenant,tx=>tx`select status,kind from email_outbox where entity_type='appointment_deposit_retention_release' and entity_id in(select id from commerce_deposit_retention_releases where retention_id=${retention.id})`);
   await writeFile('artifacts/customer-commerce/p3-release-day.json',JSON.stringify({at:new Date().toISOString(),readonly:true,independentTimezoneCutoffSqlMatches:true,days,notice,originalDecisionUnchanged:retention.hash===state.originalRetentionHash,newStripePayment:false},null,2)+'\n');console.log(JSON.stringify({verified:true,days,notice}));
  }
 }else if(mode==='open'){
  const response=await fetch(`${process.env.SUPABASE_URL}/auth/v1/token?grant_type=password`,{method:'POST',headers:{apikey:process.env.SUPABASE_ANON_KEY!,'content-type':'application/json'},body:JSON.stringify({email:'qa-local-owner@example.test',password:process.env.GF_BASELINE_PASSWORD})});if(!response.ok)throw new Error('Existing local owner login failed');const login=await response.json() as {expires_in:number};
  const previous=JSON.parse(await readFile('/tmp/commerce-merge-auth.json','utf8')) as {origins:Array<{origin:string;localStorage:Array<{name:string;value:string}>}>};const origin=previous.origins.find(o=>o.origin==='http://localhost:5297'),token=origin?.localStorage.find(v=>/^sb-.*-auth-token$/.test(v.name));if(!origin||!token)throw new Error('Existing owned Auth state required');token.value=JSON.stringify({...login,expires_at:Math.floor(Date.now()/1000)+login.expires_in});
  const path='/tmp/commerce-release-auth.json';await writeFile(path,JSON.stringify({cookies:[],origins:[origin]}),{mode:0o600});await chmod(path,0o600);browser(['state','load',path]);browser(['open',`http://localhost:5297/schedule?appointmentId=${original.appointmentId}`]);console.log(JSON.stringify({opened:true,appointmentId:original.appointmentId}));
 }else if(mode==='open-customer'){
  const {hostedManageBookingUrl}=await import('../apps/api/src/links');const url=hostedManageBookingUrl({shopSlug:'golden-foot',manageToken:original.manageToken},{...process.env,BOOKING_PAGE_ORIGIN:'http://localhost:5296'});
  if(!url||new URL(url).origin!=='http://localhost:5296')throw new Error('Existing local manage page required');browser(['open',url]);console.log(JSON.stringify({opened:true,privateTokenPrinted:false}));
 }else if(mode==='install-loss'){
  console.log(JSON.stringify(evaluate(`(()=>{const original=window.fetch.bind(window);let lost=false;window.fetch=async(...args)=>{const response=await original(...args);let request;try{request=JSON.parse(args[1]?.body??'null');}catch{}if(!lost&&String(args[0]).endsWith('/v1/commands/commerce.releaseDepositRetention')&&request?.input?.retentionId===${JSON.stringify(retention.id)}&&response.ok){lost=true;window.__releaseLoss={key:new Headers(args[1]?.headers).get('Idempotency-Key'),input:request.input,originalHttpStatus:response.status};throw new Error('QA lost response after real release commit');}return response;};return {installed:true};})()`)));
 }else if(mode==='capture-loss'){
  state.attempt=evaluate(`(()=>{const loss=window.__releaseLoss,pending=Object.keys(sessionStorage).filter(k=>k.startsWith('gf:deposit-release:')).map(k=>JSON.parse(sessionStorage.getItem(k))).find(v=>v.input?.retentionId===${JSON.stringify(retention.id)});if(loss?.originalHttpStatus!==201||pending?.key!==loss.key)throw new Error('Actual committed response and saved request required');return loss;})()`);await save();console.log(JSON.stringify({actual201Captured:true,requestSaved:true}));
 }else if(mode==='observe-replay'){
  if(!state.attempt)throw new Error('Capture original committed request first');console.log(JSON.stringify(evaluate(`(()=>{const original=window.fetch.bind(window);window.fetch=async(...args)=>{const response=await original(...args);if(String(args[0]).endsWith('/v1/commands/commerce.releaseDepositRetention')){const data=await response.clone().json();window.__releaseReplay={httpStatus:response.status,replayed:data.replayed,sameKey:new Headers(args[1]?.headers).get('Idempotency-Key')===${JSON.stringify(state.attempt.key)}};}return response;};return {observing:true};})()`)));
 }else{
  const replay=evaluate('window.__releaseReplay');if(!state.attempt||replay?.httpStatus!==200||!replay.replayed||!replay.sameKey)throw new Error('Native refreshed replay required');
  const [facts]=await withTenant(tenant,tx=>tx`select r.id as release_id,r.amount_cents,r.guest_allocation,f.id as refund_id,f.status,f.stripe_refund_id,f.fee_cents,f.net_cents,
   (select count(*)::int from commerce_events where object_id=f.stripe_refund_id and event_type like 'refund.%' and event_id like 'evt_%') as signed_refund_events,
   (select count(*)::int from commerce_deposit_retention_releases where retention_id=r.retention_id) as releases,
   (select count(*)::int from commerce_deposit_ledger where hold_id=r.hold_id and entry='retention_released') as release_entries,
   (select sum(amount_cents)::int from commerce_refunds where payment_id=r.payment_id and status='succeeded') as refunded,
   (select coalesce(sum(amount_cents),0)::int from commerce_deposit_ledger where hold_id=r.hold_id) as balance,
   (select status from commerce_appointment_holds where id=r.hold_id) as hold_status,
   (select count(*)::int from audit_log where command='commerce.releaseDepositRetention' and entity_id=r.id) as audits,
   (select count(*)::int from email_outbox where entity_type='appointment_deposit_retention_release' and entity_id=r.id) as notices
   from commerce_deposit_retention_releases r join commerce_refunds f on f.retention_release_id=r.id where r.retention_id=${retention.id}`);
  if(!facts||facts.amount_cents!==800||facts.status!=='succeeded'||facts.releases!==1||facts.release_entries!==1||facts.refunded!==2000||facts.balance!==0||facts.hold_status!=='refunded'||facts.audits!==1||facts.notices!==1||retention.hash!==state.originalRetentionHash)throw new Error('Release/refund facts not yet complete or inconsistent');
  const fingerprint=createHash('sha256').update(commerceFingerprint(CommerceReleaseDepositRetention.input.parse(state.attempt.input))).digest('hex');
  const [receipt]=await withTenant(tenant,tx=>tx`select input_fingerprint from command_idempotency where location_id=${tenant.locationId} and key=${state!.attempt!.key}`);if(receipt?.input_fingerprint!==fingerprint)throw new Error('Original request fingerprint mismatch');
  const {commerceStripeClient}=await import('../apps/api/src/commerce/client');const stripe=commerceStripeClient(),refund=await stripe.refunds.retrieve(facts.stripe_refund_id,{}, {stripeAccount:retention.stripe_account_id});
  if(refund.status!=='succeeded'||refund.amount!==800||refund.currency!=='usd'||refund.payment_intent!==retention.payment_intent_id)throw new Error('Real original-payment refund must be verified');
  const publicResponse=await fetch('http://127.0.0.1:3087/public/v1/hosted/manage',{method:'POST',headers:{'content-type':'application/json',origin:'http://localhost:5296'},body:JSON.stringify({slug:'golden-foot',manageToken:original.manageToken,locale:'zh-Hans'})});const managed=await publicResponse.json() as {booking:{deposit:{status:string;retainedCents:number;refundedCents:number;availableCents:number}}};
  if(!publicResponse.ok||managed.booking.deposit.retainedCents!==0||managed.booking.deposit.refundedCents!==2000||managed.booking.deposit.availableCents!==0)throw new Error('Original protected customer projection mismatch');
  const report={at:new Date().toISOString(),originalOrderId:original.orderId,originalRetentionId:retention.id,originalDecisionUnchanged:true,originalPaidCents:2000,priorRefundCents:1200,actualStripeReleaseRefundCents:800,originalHttpStatus:201,replay,facts,publicSummary:managed.booking.deposit,newStripePayment:false,realEmailSent:false,productionPublished:false};
  await writeFile('artifacts/customer-commerce/p3-release-native.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
 }
}finally{await closeDb();}
