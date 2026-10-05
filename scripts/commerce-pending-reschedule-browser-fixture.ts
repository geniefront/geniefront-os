// Native local pending-reservation reschedule. Preserves previous sandbox money; no payment simulation.
import {readFile,writeFile,chmod} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {assertRegressionTarget} from '../packages/db/src/qa/regressionSafety';
for(const [target,source] of [['DATABASE_URL','TEST_DATABASE_URL'],['MIGRATION_DATABASE_URL','TEST_MIGRATION_DATABASE_URL']] as const){
 const u=new URL(process.env[source]??'');if(!['127.0.0.1','localhost'].includes(u.hostname)||u.port!=='58332'||process.env.DATABASE_TEST_TARGET!=='isolated')throw new Error('Dedicated local QA only');
 u.pathname='/gf_commerce_ci';process.env[target]=u.href;
}
assertRegressionTarget(process.env);
if(process.env.COMMERCE_STRIPE_MODE!=='test'||!['localhost','127.0.0.1'].includes(new URL(process.env.SUPABASE_URL!).hostname))throw new Error('Local sandbox only');
process.env.NODE_ENV='test';process.env.COMMUNICATION_DELIVERY_MODE='capture';
const mode=process.argv[2],path='/tmp/commerce-pending-reschedule-private.json';
if(!['prepare','open-buyer','verify-pending','verify-paid'].includes(mode??''))throw new Error('Expected prepare|open-buyer|verify-pending|verify-paid');
let state:any;try{state=JSON.parse(await readFile(path,'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;state={key:crypto.randomUUID(),manageToken:`mt_${crypto.randomUUID()}`};}
async function save(){await writeFile(path,JSON.stringify(state),{mode:0o600});await chmod(path,0o600);}
const {withTenant,closeDb}=await import('../packages/db/src/index');
const tenant={orgId:'22222222-2222-4222-8222-222222222222',locationId:'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',membershipId:null};
try{
 if(mode==='prepare'){
  const r=await fetch(`${process.env.SUPABASE_URL}/auth/v1/token?grant_type=password`,{method:'POST',headers:{apikey:process.env.SUPABASE_ANON_KEY!,'content-type':'application/json'},body:JSON.stringify({email:'qa-local-owner@example.test',password:process.env.GF_BASELINE_PASSWORD})});
  if(!r.ok)throw new Error('Local owner auth required');const login=await r.json() as any;
  const [owner]=await withTenant(tenant,tx=>tx`select id from memberships where user_id=${login.user.id} and location_id=${tenant.locationId} and status='active'`);if(!owner)throw new Error('QA owner required');
  async function command(name:string,input:unknown,suffix:string){const result=await fetch(`http://127.0.0.1:3087/v1/commands/${name}`,{method:'POST',headers:{authorization:`Bearer ${login.access_token}`,'x-membership-id':owner!.id,'content-type':'application/json'},body:JSON.stringify({input,idempotencyKey:`pending-reschedule:${state.key}:${suffix}`})});const body=await result.json() as any;if(!result.ok)throw new Error(`${name} ${result.status} ${body.code??''} ${body.details?.reason??''}`);return body.result;}
  if(!state.before){const [before]=await withTenant(tenant,tx=>tx`select count(*)::int as count,md5(string_agg(row_to_json(p)::text,'|' order by id)) as hash,array_agg(id order by id) as ids from commerce_payments p`);if(before!.count!==17)throw new Error('Expected 17 preserved purchase payments');state.before=before;await save();}
  if(!state.input){
   const shopResponse=await fetch('http://127.0.0.1:3087/public/v1/hosted/shops/golden-foot?locale=en');if(!shopResponse.ok)throw new Error('Local hosted shop required');const shop=await shopResponse.json() as any;
   const {serviceId}=JSON.parse(await readFile('/tmp/commerce-deposit-sandbox-private.json','utf8'));
   const date=new Intl.DateTimeFormat('en-CA',{timeZone:shop.timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(Date.now()+5*86400000));
   const ar=await fetch(`http://127.0.0.1:3087/public/v1/availability?${new URLSearchParams({date,serviceId})}`,{headers:{'x-gf-public-key':shop.publicKey}});if(!ar.ok)throw new Error('Native availability required');
   const slots=(await ar.json() as any).slots;const slot=slots.find((s:any)=>Date.parse(s.startsAt)>Date.now());
   if(!slot)throw new Error('No available slot; do not bypass capacity');
   const {quoteAppointmentDeposit}=await import('../packages/payroll/src/commerce');const b=shop.onlineBooking;
   const amount=quoteAppointmentDeposit(10000,b.depositMethod==='percentage'?{percentBps:b.depositPercentBps}:{fixedAmountCents:b.depositAmountCents});if(amount!==2000)throw new Error('Expected current $20 quote');
   Object.assign(state,{startsAt:slot.startsAt,timezone:shop.timezone,serviceId,date});
   state.input={businessKey:state.key,depositConsent:{accepted:true,policyVersion:b.depositPolicyVersion,serviceTotalCents:10000,amountCents:amount},appointment:{source:'web',customerId:null,
    items:[{serviceId,startsAt:slot.startsAt,...(slot.staff?{membershipId:slot.staff.id}:{})}],guest:{manageToken:state.manageToken,bookingSmsConsent:false,
     customer:{name:'Pending reschedule QA',email:'pending-reschedule@example.test',phoneE164:'+12025550841'}}}};await save();
  }
  if(!state.holdId){Object.assign(state,await command('commerce.holdAppointment',state.input,'hold'));await save();}
  if(!state.orderId){Object.assign(state,await command('commerce.startDepositCheckout',{holdId:state.holdId},'checkout'));await save();}
  await command('commerce.sendDepositNotice',{holdId:state.holdId,reason:'Native pending reservation reschedule verification'},'notice');
  if(!state.original){const [original]=await withTenant(tenant,tx=>tx`select h.amount_cents,h.service_total_cents,h.policy_snapshot,h.expires_at::text,h.order_id,o.snapshot from commerce_appointment_holds h join commerce_orders o on o.id=h.order_id where h.id=${state.holdId}`);state.original=original;await save();}
  console.log(JSON.stringify({prepared:true,appointmentId:state.appointmentId,holdId:state.holdId,orderId:state.orderId,startsAt:state.startsAt,expiresAt:state.expiresAt,amountCents:2000,oldPaymentCount:state.before.count,oldPaymentHash:state.before.hash}));
 }else if(mode==='open-buyer'){
  if(!state.appointmentId)throw new Error('Prepare first');
  const r=spawnSync(process.execPath,['/Users/naiyouzhu/.npm/_npx/6de2aa2fded2970c/node_modules/agent-browser/bin/agent-browser.js','--session','commerce-pending-reschedule-buyer','open',`http://localhost:5296/l/golden-foot#g/${state.manageToken}`],{encoding:'utf8'});if(r.status!==0)throw new Error('Owned native browser failed');console.log(JSON.stringify({openedOriginalManagementLink:true,tokenPrinted:false}));
 }else{
  if(!state.original)throw new Error('Original snapshot required');
  const [prior]=await withTenant(tenant,tx=>tx`select count(*)::int as count,md5(string_agg(row_to_json(p)::text,'|' order by id)) as hash from commerce_payments p where id=any(${state.before.ids}::uuid[])`);
  if(prior!.count!==state.before.count||prior!.hash!==state.before.hash)throw new Error('Previous payment facts changed');
  const [snapshot]=await withTenant(tenant,tx=>tx`select h.amount_cents,h.service_total_cents,h.policy_snapshot,h.expires_at::text,h.order_id,o.snapshot from commerce_appointment_holds h join commerce_orders o on o.id=h.order_id where h.id=${state.holdId}`);
  if(JSON.stringify(snapshot)!==JSON.stringify(state.original))throw new Error('Reschedule changed original quote, payment, deadline or policy');
  const [facts]=await withTenant(tenant,tx=>tx`select a.status,a.deposit_status,a.starts_at::text,a.self_reschedule_count,h.status as hold_status,p.status as payment_status,p.amount_cents,
    p.checkout_session_id,p.stripe_account_id,p.fee_cents,p.net_cents,p.balance_transaction_id,
    (select count(*)::int from commerce_payments where order_id=h.order_id) as payments,
    (select count(*)::int from commerce_deposit_ledger where hold_id=h.id and entry='collected') as collections,
    (select count(*)::int from email_outbox where entity_id=a.id and kind='appointment_confirm' and to_email='pending-reschedule@example.test') as confirmations,
    (select count(*)::int from email_outbox where entity_id=a.id and kind='appointment_confirm' and to_email='pending-reschedule@example.test' and status='captured') as captured_confirmations,
    (select count(*)::int from email_outbox where entity_id=a.id and kind='appointment_deposit_pending') as requests,
    (select count(*)::int from email_outbox where entity_id=a.id and kind='appointment_deposit_pending' and status='captured') as captured_requests,
    (select count(*)::int from commerce_events where object_id=p.checkout_session_id and event_type='checkout.session.completed' and event_id like 'evt_%') as signed_events
    from appointments a join commerce_appointment_holds h on h.appointment_id=a.id join commerce_payments p on p.order_id=h.order_id where h.id=${state.holdId}`);
  if(!facts||new Date(facts.starts_at).toISOString()===state.startsAt||facts.self_reschedule_count!==1||facts.payments!==1||facts.requests!==2||facts.captured_requests!==2)throw new Error('Native reschedule and captured instructions required');
  const notices=await withTenant(tenant,tx=>tx`select body_text from email_outbox where entity_id=${state.appointmentId} and kind='appointment_deposit_pending' order by created_at`);
  const latest=notices[1]!.body_text;if(!latest.includes('still awaiting deposit payment')&&!latest.includes('预约仍待付定金'))throw new Error('Pending schedule notice missing');
  const [customer]=await withTenant(tenant,tx=>tx`select c.locale from customers c join appointments a on a.customer_id=c.id where a.id=${state.appointmentId}`);
  const locale=customer?.locale??'zh-Hans',formatter=new Intl.DateTimeFormat(locale,{timeZone:state.timezone,dateStyle:'medium',timeStyle:'short'});
  if(!latest.includes(formatter.format(new Date(facts.starts_at)))||!latest.includes(formatter.format(new Date(state.startsAt)))
    ||!latest.includes(formatter.format(new Date(state.expiresAt))))throw new Error('Captured notice must contain new time, original time and unchanged deadline');
  const noticeEvidence={locale,newTime:true,previousTime:true,originalDeadline:true,pendingPaymentExplicit:true};
  let stripeVerified=false;
  if(mode==='verify-pending'){if(facts.deposit_status!=='pending'||facts.collections||facts.confirmations)throw new Error('Unpaid reservation was prematurely confirmed');state.pendingVerified=true;await save();}
  else{
   if(!state.pendingVerified||facts.deposit_status!=='paid'||facts.payment_status!=='paid'||facts.collections!==1||facts.confirmations!==1||facts.captured_confirmations!==1||facts.signed_events<1||facts.fee_cents!==88||facts.net_cents!==1912||!facts.balance_transaction_id)throw new Error('One real collected deposit and confirmation required');
   const {commerceStripeClient}=await import('../apps/api/src/commerce/client');const session=await commerceStripeClient().checkout.sessions.retrieve(facts.checkout_session_id,{}, {stripeAccount:facts.stripe_account_id});
   if(session.livemode||session.status!=='complete'||session.payment_status!=='paid'||session.amount_total!==2000||session.currency!=='usd'||session.metadata?.gf_order_id!==state.orderId||session.client_reference_id!==state.orderId)throw new Error('Actual sandbox Checkout mismatch');stripeVerified=true;
  }
  const [all]=await withTenant(tenant,tx=>tx`select count(*)::int as count,md5(string_agg(row_to_json(p)::text,'|' order by id)) as hash from commerce_payments p`);
  const report={at:new Date().toISOString(),mode,appointmentId:state.appointmentId,holdId:state.holdId,orderId:state.orderId,nativeBuyerRescheduled:true,originalQuotePolicyDeadlineUnchanged:true,
   previousPayments:prior,currentPayments:all,facts,noticeEvidence,stripeVerified,notificationDelivery:'capture',realEmailDeliveryVerified:false,productionPublished:false,goalComplete:false};
  await writeFile(`artifacts/customer-commerce/p3-pending-reschedule-${mode==='verify-pending'?'pending':'paid'}.json`,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
 }
}finally{await closeDb();}
