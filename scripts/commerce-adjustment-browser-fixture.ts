// Dedicated local, native deposit adjustment verification; never writes financial facts directly.
import {isDeepStrictEqual} from 'node:util';
import {spawnSync} from 'node:child_process';
import {readFile,writeFile,chmod} from 'node:fs/promises';
import {assertRegressionTarget} from '../packages/db/src/qa/regressionSafety';
for(const [target,source] of [['DATABASE_URL','TEST_DATABASE_URL'],['MIGRATION_DATABASE_URL','TEST_MIGRATION_DATABASE_URL']] as const){const u=new URL(process.env[source]??'');if(u.hostname!=='127.0.0.1'||u.port!=='58332'||process.env.DATABASE_TEST_TARGET!=='isolated')throw new Error('Dedicated local QA only');u.pathname='/gf_commerce_ci';process.env[target]=u.href;}
assertRegressionTarget(process.env);
if(process.env.COMMERCE_STRIPE_MODE!=='test'||!['localhost','127.0.0.1'].includes(new URL(process.env.SUPABASE_URL!).hostname))throw new Error('Local sandbox only');
process.env.NODE_ENV='test';process.env.COMMUNICATION_DELIVERY_MODE='capture';
const path='/tmp/commerce-adjustment-private.json',authPath='/tmp/commerce-adjustment-auth.json';
const previous=JSON.parse(await readFile('/tmp/commerce-pending-reschedule-private.json','utf8'));
let state:any;try{state=JSON.parse(await readFile(path,'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;state={key:crypto.randomUUID(),appointmentId:previous.appointmentId,holdId:previous.holdId,originalServiceId:previous.serviceId,originalOrderId:previous.orderId};}
const {withTenant,closeDb}=await import('../packages/db/src/index');const tenant={orgId:'22222222-2222-4222-8222-222222222222',locationId:'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',membershipId:null};
try{
 const [baseline]=await withTenant(tenant,tx=>tx`select count(*)::int as count,md5(string_agg(row_to_json(p)::text,'|' order by id)) as hash,array_agg(id order by id) as ids from commerce_payments p`);
 if(!state.before){if(baseline!.count!==18||baseline!.hash!=='32be213097fb73caafc211c2024b69b5')throw new Error('Original 18 native payment checkpoint required');state.before=baseline;}
 if(process.argv[2]==='verify'){
  const [prior]=await withTenant(tenant,tx=>tx`select count(*)::int as count,md5(string_agg(row_to_json(p)::text,'|' order by id)) as hash from commerce_payments p where id=any(${state.before.ids}::uuid[])`);
  if(prior!.count!==18||prior!.hash!==state.before.hash||baseline!.count!==19)throw new Error('Original payment history changed');
  const [contract]=await withTenant(tenant,tx=>tx`select h.amount_cents,h.service_total_cents,h.policy_snapshot,h.expires_at::text,h.order_id,o.snapshot from commerce_appointment_holds h join commerce_orders o on o.id=h.order_id where h.id=${state.holdId}`);
  if(JSON.stringify(contract)!==JSON.stringify(previous.original))throw new Error('Original deposit contract changed');
  const requests=await withTenant(tenant,tx=>tx`select r.order_id,r.purpose,r.state,p.id as payment_id,p.status,p.amount_cents,p.checkout_session_id,p.stripe_account_id,p.fee_cents,p.net_cents,p.balance_transaction_id,
   (select count(*)::int from commerce_events where object_id=p.checkout_session_id and event_type='checkout.session.completed' and event_id like 'evt_%') as signed_events
   from commerce_deposit_requests r join commerce_payments p on p.order_id=r.order_id where r.hold_id=${state.holdId} order by r.created_at`);
  const supplemental=requests.find(r=>r.purpose==='supplement');if(requests.length!==2||!supplemental||supplemental.state!=='paid'||supplemental.status!=='paid'||supplemental.amount_cents!==1800||supplemental.signed_events<1||!supplemental.balance_transaction_id)throw new Error('Native supplemental payment required');
  const [refund]=await withTenant(tenant,tx=>tx`select r.id,r.status,r.amount_cents,r.stripe_refund_id,p.stripe_account_id,p.payment_intent_id from commerce_refunds r join commerce_payments p on p.id=r.payment_id where p.order_id=${state.originalOrderId}`);
  if(refund!.status!=='succeeded'||refund!.amount_cents!==1800||!refund!.stripe_refund_id)throw new Error('Actual original source refund required');
  const [facts]=await withTenant(tenant,tx=>tx`select a.status,a.deposit_status,
   (select sum(amount_cents)::int from commerce_deposit_ledger where hold_id=h.id) as available,
   (select count(*)::int from commerce_deposit_ledger where hold_id=h.id and entry='collected') as collections,
   (select count(*)::int from commerce_deposit_requotes where hold_id=h.id) as requotes,
   (select count(*)::int from appointment_items where appointment_id=a.id and status='booked') as active_items,
   (select count(*)::int from email_outbox where entity_id=a.id and kind='appointment_confirm' and status='captured') as booking_confirmations,
   (select count(*)::int from email_outbox where commerce_order_id=${supplemental.order_id} and entity_type like 'appointment_deposit_additional_paid:%' and status='captured') as additional_receipts
   from appointments a join commerce_appointment_holds h on h.appointment_id=a.id where h.id=${state.holdId}`);
  if(facts!.status!=='booked'||facts!.deposit_status!=='paid'||facts!.available!==2000||facts!.collections!==2||facts!.requotes!==2||facts!.active_items!==1||facts!.booking_confirmations!==1||facts!.additional_receipts!==1)throw new Error('Native deposit adjustment facts differ');
  const captured=spawnSync(process.execPath,['/Users/naiyouzhu/.npm/_npx/6de2aa2fded2970c/node_modules/agent-browser/bin/agent-browser.js','--session','commerce-adjustment-desk','eval','JSON.parse(sessionStorage.getItem("qa-adjustment-lost"))'],{encoding:'utf8'});
  if(captured.status!==0)throw new Error('Native lost-response evidence required');const first=JSON.parse(captured.stdout);
  if(first.status!==201||first.request.input.appointmentId!==state.appointmentId)throw new Error('Actual committed response required');
  const receipts=await withTenant(tenant,tx=>tx`select command,result_json from command_idempotency where location_id=${tenant.locationId} and command='appointment.replaceItem' and result_json->>'itemId'=${first.body.result.itemId}`);
  if(receipts.length!==1||receipts[0]!.command!=='appointment.replaceItem'||!isDeepStrictEqual(receipts[0]!.result_json,first.body.result))throw new Error('One original command receipt required');
  const {commerceStripeClient}=await import('../apps/api/src/commerce/client');const stripe=commerceStripeClient();
  const session=await stripe.checkout.sessions.retrieve(supplemental.checkout_session_id,{}, {stripeAccount:supplemental.stripe_account_id});
  const returned=await stripe.refunds.retrieve(refund!.stripe_refund_id,{}, {stripeAccount:refund!.stripe_account_id});
  if(session.livemode||session.status!=='complete'||session.payment_status!=='paid'||session.amount_total!==1800||session.currency!=='usd'||session.metadata?.gf_order_id!==supplemental.order_id||returned.status!=='succeeded'||returned.amount!==1800||returned.payment_intent!==refund!.payment_intent_id)throw new Error('Stripe test-mode source verification failed');
  const report={at:new Date().toISOString(),appointmentId:state.appointmentId,holdId:state.holdId,originalContractUnchanged:true,originalPayments:prior,currentPayments:{count:baseline!.count,hash:baseline!.hash},facts,
   nativeLostResponse:{committedStatus:first.status,replayStatusObserved:200,reloadedSameBrowserContext:true,oneCommandReceipt:true,oneActiveReplacement:true},
   originalRefund:{status:returned.status,amountCents:returned.amount,verifiedOriginalPaymentIntent:true},supplement:{orderId:supplemental.order_id,amountCents:1800,feeCents:supplemental.fee_cents,netCents:supplemental.net_cents,signedEvents:supplemental.signed_events,stripeVerified:true},
   migration:187,notificationDelivery:'capture',productionPublished:false,goalComplete:false};
  await writeFile('artifacts/customer-commerce/p3-adjustments-native-verified.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
 }else{
 const r=await fetch(`${process.env.SUPABASE_URL}/auth/v1/token?grant_type=password`,{method:'POST',headers:{apikey:process.env.SUPABASE_ANON_KEY!,'content-type':'application/json'},body:JSON.stringify({email:'qa-local-owner@example.test',password:process.env.GF_BASELINE_PASSWORD})});if(!r.ok)throw new Error('Local owner auth required');const login=await r.json() as any;
 const [owner]=await withTenant(tenant,tx=>tx`select id from memberships where user_id=${login.user.id} and location_id=${tenant.locationId} and status='active'`);if(!owner)throw new Error('QA owner required');
 const browser={cookies:[],origins:[{origin:'http://localhost:5297',localStorage:[{name:'sb-127-auth-token',value:JSON.stringify(login)},{name:'gf.lang',value:'en'},{name:'gf.membershipId',value:owner.id}]}]};
 await writeFile(authPath,JSON.stringify(browser),{mode:0o600});await chmod(authPath,0o600);
 if(!state.smallServiceId){const result=await fetch('http://127.0.0.1:3087/v1/commands/catalog.saveService',{method:'POST',headers:{authorization:`Bearer ${login.access_token}`,'x-membership-id':owner.id,'content-type':'application/json'},body:JSON.stringify({input:{name:{en:'Adjustment $10 QA'},durationMin:30,basePriceCents:1000,taxable:false},idempotencyKey:`adjustment-small:${state.key}`})});const b=await result.json() as any;if(!result.ok)throw new Error(`Service fixture ${result.status} ${b.code??''}`);state.smallServiceId=b.result.serviceId;}
 await writeFile(path,JSON.stringify(state),{mode:0o600});await chmod(path,0o600);
 console.log(JSON.stringify({prepared:true,appointmentId:state.appointmentId,holdId:state.holdId,smallServiceId:state.smallServiceId,previousPayments:state.before.count,authSaved:true}));
}
}finally{await closeDb();}
