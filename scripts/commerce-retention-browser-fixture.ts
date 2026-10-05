// Actual local HTTP commands and hosted sandbox payment; no schema reset or fabricated provider facts.
import {readFile,writeFile,chmod} from 'node:fs/promises';
import {assertRegressionTarget} from '../packages/db/src/qa/regressionSafety';
for(const [target,source] of [['DATABASE_URL','TEST_DATABASE_URL'],['MIGRATION_DATABASE_URL','TEST_MIGRATION_DATABASE_URL']] as const){
  const url=new URL(process.env[source]??'');if(!['localhost','127.0.0.1'].includes(url.hostname)||url.port!=='58332')throw new Error('Dedicated QA database required');
  url.pathname='/gf_commerce_ci';process.env[target]=url.href;
}
assertRegressionTarget(process.env);
if(process.env.COMMERCE_STRIPE_MODE!=='test'||!['localhost','127.0.0.1'].includes(new URL(process.env.SUPABASE_URL!).hostname))throw new Error('Local test mode only');
process.env.NODE_ENV='test';process.env.COMMUNICATION_DELIVERY_MODE='capture';
const mode=process.argv[2];if(!['prepare','restore','cancel','refund','reconcile','verify'].includes(mode??''))throw new Error('Expected prepare|restore|cancel|refund|reconcile|verify');
const tenant={orgId:'22222222-2222-4222-8222-222222222222',locationId:'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'};
const path='/tmp/commerce-retention-browser-private.json',notice='Sandbox QA: agreed unused deposit may be retained after the original cutoff; staff will record the decision.';
type Policy={enabled:boolean;cancelCutoffHours:number;retainDepositAfterCutoff:boolean;cancellationPolicyNotice:string}&Record<string,unknown>;
type State={key:string;manageToken:string;previousPolicy?:Policy;input?:unknown;holdId?:string;appointmentId?:string;orderId?:string;refundId?:string;policyRestored?:boolean};
const {withTenant,closeDb,readOnlineBooking}=await import('../packages/db/src/index');
const {generateManageToken}=await import('../apps/api/src/public/bookingToken');
let state:State;try{state=JSON.parse(await readFile(path,'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;state={key:crypto.randomUUID(),manageToken:generateManageToken()};}
async function save(file:string,value:unknown){await writeFile(file,JSON.stringify(value),{mode:0o600});await chmod(file,0o600);}
try{
  const auth=await fetch(`${process.env.SUPABASE_URL}/auth/v1/token?grant_type=password`,{method:'POST',headers:{apikey:process.env.SUPABASE_ANON_KEY!,'content-type':'application/json'},
    body:JSON.stringify({email:'qa-local-owner@example.test',password:process.env.GF_BASELINE_PASSWORD})});
  if(!auth.ok)throw new Error('Existing local QA owner login required');const login=await auth.json() as {access_token:string;expires_in:number;user:{id:string}};
  const [member]=await withTenant(tenant,tx=>tx`select id from memberships where user_id=${login.user.id} and location_id=${tenant.locationId} and status='active'`);
  if(!member)throw new Error('Existing QA owner membership required');
  async function command<T=Record<string,unknown>>(name:string,input:unknown,suffix:string):Promise<T>{
    const r=await fetch(`http://127.0.0.1:3087/v1/commands/${name}`,{method:'POST',headers:{authorization:`Bearer ${login.access_token}`,'x-membership-id':member!.id,'content-type':'application/json'},
      body:JSON.stringify({input,idempotencyKey:`retention-browser:${state.key}:${suffix}`})});
    const out=await r.json() as {result:T;code?:string;details?:{reason?:string}};
    if(!r.ok)throw new Error(`QA command ${name}: ${r.status} ${out.code??''} ${out.details?.reason??''}`);return out.result;
  }
  const currentPolicy=async()=>{
    const [loc]=await withTenant(tenant,tx=>tx`select settings from locations where id=${tenant.locationId}`);return readOnlineBooking(loc!.settings);
  };
  const fullPolicy=(p:ReturnType<typeof readOnlineBooking>):Policy=>{
    const {depositPercentBps,...fixed}=p;return (p.depositMethod==='percentage'?p:fixed) as Policy;
  };
  if(mode==='restore'){
    const [audit]=await withTenant(tenant,tx=>tx`select id,before->'onlineBooking' as settings from audit_log
      where location_id=${tenant.locationId} and actor_id=${member.id} and command='location.saveOnlineBooking'
      and after->'onlineBooking'->>'cancellation_policy_notice'=${notice} and after->'onlineBooking'->>'cancel_cutoff_hours'='48'
      order by at,id limit 1`);
    if(!audit?.settings)throw new Error('Exact original settings audit required; do not guess');
    state.previousPolicy=fullPolicy(readOnlineBooking({online_booking:audit.settings}));
    await command('location.saveOnlineBooking',state.previousPolicy,'restore-from-audit');state.policyRestored=true;
    if(!state.holdId)state.input=undefined;await save(path,state);
    const now=await currentPolicy();
    if(!now.depositRequired||now.cancelCutoffHours!==state.previousPolicy.cancelCutoffHours)throw new Error('Restored QA policy mismatch');
    console.log(JSON.stringify({restoredFromAudit:true,auditId:audit.id,depositRequired:now.depositRequired,cancelCutoffHours:now.cancelCutoffHours}));
    await closeDb();process.exit(0);
  }
  if(mode==='prepare'){
    if(!state.previousPolicy){state.previousPolicy=fullPolicy(await currentPolicy());await save(path,state);}
    if(state.previousPolicy.depositRequired!==true)throw new Error('Complete original deposit settings required');
    if(!state.holdId||!state.orderId){
      const cycle=crypto.randomUUID();
      await command('location.saveOnlineBooking',{...state.previousPolicy,cancelCutoffHours:48,retainDepositAfterCutoff:true,cancellationPolicyNotice:notice},'policy-in-'+cycle);
      try{
        if(!state.input){
        const {serviceId}=JSON.parse(await readFile('/tmp/commerce-deposit-sandbox-private.json','utf8')) as {serviceId:string};
        const shop=await fetch('http://127.0.0.1:3087/public/v1/hosted/shops/golden-foot?locale=en');if(!shop.ok)throw new Error('QA shop required');
        const data=await shop.json() as {timezone:string;publicKey:string;onlineBooking:{depositPolicyVersion:string}};
        const date=new Intl.DateTimeFormat('en-CA',{timeZone:data.timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(Date.now()+86400000));
        const availability=await fetch(`http://127.0.0.1:3087/public/v1/availability?${new URLSearchParams({date,serviceId})}`,{headers:{'x-gf-public-key':data.publicKey}});
        if(!availability.ok)throw new Error('Real available slot required');const slots=await availability.json() as {slots:Array<{startsAt:string;staff:{id:string}|null}>};
        const slot=slots.slots.find(s=>Date.parse(s.startsAt)>Date.now()&&Date.parse(s.startsAt)<Date.now()+48*3600000);
        if(!slot)throw new Error('No eligible real slot; do not bypass capacity or policy');
        state.input={businessKey:state.key,depositConsent:{accepted:true,policyVersion:data.onlineBooking.depositPolicyVersion,serviceTotalCents:10000,amountCents:2000},
          appointment:{source:'web',customerId:null,items:[{serviceId,startsAt:slot.startsAt,...(slot.staff?{membershipId:slot.staff.id}:{})}],
            guest:{manageToken:state.manageToken,bookingSmsConsent:false,customer:{name:'Deposit retention browser QA',email:'retention-browser-qa@example.test',phoneE164:'+12025550775'}}}};
        await save(path,state);}
        const h=await command<{holdId:string;appointmentId:string}>('commerce.holdAppointment',state.input,'hold');Object.assign(state,h);await save(path,state);
        const order=await command<{orderId:string}>('commerce.startDepositCheckout',{holdId:state.holdId},'checkout');state.orderId=order.orderId;await save(path,state);
      }finally{
        const now=await currentPolicy();if(now.cancelCutoffHours!==48||!now.retainDepositAfterCutoff||now.cancellationPolicyNotice!==notice)
          throw new Error('QA policy changed independently; do not overwrite the new settings');
        await command('location.saveOnlineBooking',{...state.previousPolicy,enabled:now.enabled},'policy-out-'+cycle);state.policyRestored=true;await save(path,state);
      }
    }
    if(!state.holdId||!state.orderId||!state.policyRestored)throw new Error('Original hold/order and restored QA policy required');
    const authPath='/tmp/commerce-desk-auth.json',browser=JSON.parse(await readFile(authPath,'utf8')) as {origins:Array<{origin:string;localStorage:Array<{name:string;value:string}>}>};
    const origin=browser.origins.find(o=>o.origin==='http://localhost:5297'),entry=origin?.localStorage.find(v=>/^sb-.*-auth-token$/.test(v.name));
    if(!origin||!entry)throw new Error('Owned browser auth state missing');entry.value=JSON.stringify({...login,expires_at:Math.floor(Date.now()/1000)+login.expires_in});
    await save(authPath,{cookies:[],origins:[origin]});
    console.log(JSON.stringify({prepared:true,appointmentId:state.appointmentId,holdId:state.holdId,orderId:state.orderId,policyRestored:true,privateStatePath:path}));
  }else{
    if(!state.holdId||!state.appointmentId)throw new Error('Original retained-deposit story required');
    const [facts]=await withTenant(tenant,tx=>tx`select h.status,h.amount_cents,h.service_total_cents,h.policy_snapshot,h.reserved_cents,a.status as appointment_status,
      p.id as payment_id,p.status as payment_status,p.checkout_session_id,p.stripe_account_id,p.fee_cents,p.net_cents,p.balance_transaction_id,
      (select count(*)::int from commerce_events where object_id=p.checkout_session_id and event_type='checkout.session.completed' and event_id like 'evt_%') as signed_checkout_events,
      (select coalesce(sum(amount_cents),0)::int from commerce_deposit_ledger where hold_id=h.id) as available,
      (select count(*)::int from commerce_deposit_ledger where hold_id=h.id and entry='collected') as collection_rows,
      (select count(*)::int from commerce_deposit_ledger where hold_id=h.id and entry='retained') as retention_rows,
      (select -coalesce(sum(amount_cents),0)::int from commerce_deposit_ledger where hold_id=h.id and entry='retained') as retained_cents,
      (select count(*)::int from commerce_deposit_retentions where hold_id=h.id) as decisions,
      (select count(*)::int from email_outbox where kind='appointment_deposit_retained' and entity_id in(select id from commerce_deposit_retentions where hold_id=h.id)) as retention_notices,
      (select count(*)::int from email_outbox where kind='appointment_deposit_retained' and status='captured' and entity_id in(select id from commerce_deposit_retentions where hold_id=h.id)) as captured_retention_notices
      from commerce_appointment_holds h join appointments a on a.id=h.appointment_id join commerce_payments p on p.order_id=h.order_id where h.id=${state.holdId}`);
    if(!facts||facts.payment_status!=='paid'||facts.collection_rows!==1||facts.signed_checkout_events<1||facts.policy_snapshot.retainAfterCutoff!==true
      ||facts.policy_snapshot.cancelCutoffHours!==48||facts.policy_snapshot.consent?.accepted!==true||facts.service_total_cents!==10000)throw new Error('Actual paid original retention contract required');
    if(mode==='cancel'){
      await command('appointment.cancel',{appointmentId:state.appointmentId,reason:'guest_changed_mind',keepStaffTurn:false},'cancel');
      console.log(JSON.stringify({cancelled:true,appointmentId:state.appointmentId,holdId:state.holdId,requiresReasonedRetention:true}));
    }else if(mode==='refund'){
      if(facts.retained_cents!==800||facts.decisions!==1)throw new Error('Original $8 browser retention required');
      const r=await command<{refundId:string}>('commerce.requestRefund',{paymentId:facts.payment_id,amountCents:1200,reason:'Return the unretained QA deposit'},'refund');
      state.refundId=r.refundId;await save(path,state);console.log(JSON.stringify({requested:true,refundId:r.refundId,amountCents:1200}));
    }else if(mode==='reconcile'){
      const r=await fetch(`http://127.0.0.1:3087/v1/commerce/orders/${state.orderId}/reconcile`,{method:'POST',
        headers:{authorization:`Bearer ${login.access_token}`,'x-membership-id':member.id,'content-type':'application/json'},body:'{}'});
      if(!r.ok)throw new Error(`Original provider reconciliation failed ${r.status}`);
      console.log(JSON.stringify({reconciled:true,orderId:state.orderId}));
    }else{
      const {commerceStripeClient}=await import('../apps/api/src/commerce/client');
      const session=await commerceStripeClient().checkout.sessions.retrieve(facts.checkout_session_id,{}, {stripeAccount:facts.stripe_account_id});
      if(session.livemode||session.status!=='complete'||session.payment_status!=='paid'||session.amount_total!==2000||session.currency!=='usd'
        ||facts.stripe_account_id!==process.env.COMMERCE_TEST_ACCOUNT_ID||session.client_reference_id!==state.orderId
        ||session.metadata?.gf_order_id!==state.orderId||session.metadata.gf_domain!=='customer_commerce'
        ||session.metadata.gf_org_id!==tenant.orgId||session.metadata.gf_location_id!==tenant.locationId)
        throw new Error('Original sandbox Checkout must be paid');
      if(facts.retained_cents!==800||facts.retention_rows!==1||facts.decisions!==1||facts.retention_notices!==1||facts.captured_retention_notices!==1||facts.appointment_status!=='cancelled')throw new Error('Actual browser retention invariants failed');
      const response=await fetch('http://127.0.0.1:3087/public/v1/hosted/manage',{method:'POST',headers:{'content-type':'application/json',origin:'http://localhost:5296'},
        body:JSON.stringify({slug:'golden-foot',manageToken:state.manageToken,locale:'zh-Hans'})});
      const managed=await response.json() as {booking:{deposit:{status:string;retainedCents:number;refundedCents:number;availableCents:number;serviceRemainingCents:number;checkoutUrl:string|null}}};
      if(!response.ok||managed.booking.deposit.retainedCents!==800||managed.booking.deposit.serviceRemainingCents!==0||managed.booking.deposit.checkoutUrl!==null)throw new Error('Managed retention projection failed');
      let refund:Record<string,unknown>|null=null;
      if(state.refundId){
        const [r]=await withTenant(tenant,tx=>tx`select r.status,r.amount_cents,r.stripe_refund_id,r.fee_cents,r.net_cents,r.balance_transaction_id,
          (select count(*)::int from commerce_events where object_id=r.stripe_refund_id and event_type like 'refund.%' and event_id like 'evt_%') as signed_refund_events
          from commerce_refunds r where r.id=${state.refundId!} and r.payment_id=${facts.payment_id}`);
        const actual=await commerceStripeClient().refunds.retrieve(r!.stripe_refund_id,{}, {stripeAccount:facts.stripe_account_id});
        const originalIntent=typeof session.payment_intent==='string'?session.payment_intent:session.payment_intent?.id;
        const refundIntent=typeof actual.payment_intent==='string'?actual.payment_intent:actual.payment_intent?.id;
        if(r!.status!=='succeeded'||actual.status!=='succeeded'||actual.amount!==1200||actual.currency!=='usd'||!originalIntent||refundIntent!==originalIntent
          ||r!.signed_refund_events<1||facts.available!==0
          ||facts.status!=='retained'||managed.booking.deposit.refundedCents!==1200)throw new Error('Actual unretained original refund must succeed');refund=r!;
      }
      const currentMatchesPriorPolicy=JSON.stringify(fullPolicy(await currentPolicy()))===JSON.stringify(state.previousPolicy);
      const report={at:new Date().toISOString(),browserRetentionVerified:true,actualLocalHttp:true,actualOriginalStripeCheckoutVerified:true,originalRefundVerified:!!refund,
        appointmentId:state.appointmentId,holdId:state.holdId,facts,publicSummary:managed.booking.deposit,refund,policyRestored:state.policyRestored,
        currentMatchesPriorPolicy,serviceConsumed:false,notificationDelivery:'capture',realEmailDeliveryVerified:false,bankPayoutVerified:false,goalComplete:false,productionPublished:false};
      await writeFile(`artifacts/customer-commerce/browser-deposit-retention${refund?'-refunded':''}.json`,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
    }
  }
}finally{await closeDb();}
