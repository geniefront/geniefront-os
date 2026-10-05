// Real local API/browser waiver evidence. No database money writes, provider simulation, or reset.
import {readFile,writeFile,chmod} from 'node:fs/promises';
import {assertRegressionTarget} from '../packages/db/src/qa/regressionSafety';
import {quoteAppointmentDeposit} from '../packages/payroll/src/commerce';
for(const [target,source] of [['DATABASE_URL','TEST_DATABASE_URL'],['MIGRATION_DATABASE_URL','TEST_MIGRATION_DATABASE_URL']] as const){
  const u=new URL(process.env[source]??'');if(!['127.0.0.1','localhost'].includes(u.hostname)||u.port!=='58332')throw new Error('Dedicated QA database required');
  u.pathname='/gf_commerce_ci';process.env[target]=u.href;
}
assertRegressionTarget(process.env);
if(!['localhost','127.0.0.1'].includes(new URL(process.env.SUPABASE_URL!).hostname)||process.env.COMMERCE_STRIPE_MODE!=='test')throw new Error('Local QA only');
const mode=process.argv[2];if(!['prepare','verify'].includes(mode??''))throw new Error('Expected prepare|verify');
const path='/tmp/commerce-waiver-browser-private.json',tenant={orgId:'22222222-2222-4222-8222-222222222222',locationId:'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'};
type State={businessKey:string;manageToken:string;startsAt?:string;staffId?:string;holdId?:string;appointmentId?:string;input?:unknown};
let state:State;try{state=JSON.parse(await readFile(path,'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;
  state={businessKey:crypto.randomUUID(),manageToken:`mt_${crypto.randomUUID()}`};}
const save=async()=>{await writeFile(path,JSON.stringify(state),{mode:0o600});await chmod(path,0o600);};
const {withTenant,closeDb}=await import('../packages/db/src/index');
try{
  if(mode==='prepare'){
    const auth=await fetch(`${process.env.SUPABASE_URL}/auth/v1/token?grant_type=password`,{method:'POST',headers:{apikey:process.env.SUPABASE_ANON_KEY!,'content-type':'application/json'},
      body:JSON.stringify({email:'qa-local-owner@example.test',password:process.env.GF_BASELINE_PASSWORD})});
    if(!auth.ok)throw new Error(`Local QA login failed ${auth.status}`);const login=await auth.json() as {access_token:string;expires_in:number;user:{id:string}};
    const [m]=await withTenant(tenant,tx=>tx`select id from memberships where location_id=${tenant.locationId} and user_id=${login.user.id} and status='active'`);
    if(!m)throw new Error('QA owner membership required');
    const fixture=JSON.parse(await readFile('/tmp/commerce-deposit-sandbox-private.json','utf8')) as {serviceId:string};
    if(!state.input){
      const shopResponse=await fetch('http://127.0.0.1:3087/public/v1/hosted/shops/golden-foot?locale=en');if(!shopResponse.ok)throw new Error('QA shop missing');
      const shop=await shopResponse.json() as {timezone:string;publicKey:string;onlineBooking:{depositMethod:string;depositAmountCents:number;depositPercentBps:number;depositPolicyVersion:string}};
      const date=new Intl.DateTimeFormat('en-CA',{timeZone:shop.timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(Date.now()+86400000));
      const availability=await fetch(`http://127.0.0.1:3087/public/v1/availability?${new URLSearchParams({date,serviceId:fixture.serviceId})}`,{headers:{'x-gf-public-key':shop.publicKey}});
      if(!availability.ok)throw new Error(`QA availability failed ${availability.status}`);
      const slots=await availability.json() as {slots:Array<{startsAt:string;staff:{id:string}|null}>};
      const slot=slots.slots.find(s=>Date.parse(s.startsAt)>Date.now());if(!slot)throw new Error('No real available QA slot; do not bypass capacity');
      const amount=quoteAppointmentDeposit(10000,shop.onlineBooking.depositMethod==='percentage'?{percentBps:shop.onlineBooking.depositPercentBps}:{fixedAmountCents:shop.onlineBooking.depositAmountCents});
      state.startsAt=slot.startsAt;state.staffId=slot.staff?.id;
      state.input={businessKey:state.businessKey,depositConsent:{accepted:true,policyVersion:shop.onlineBooking.depositPolicyVersion,serviceTotalCents:10000,amountCents:amount},
        appointment:{source:'web',customerId:null,items:[{serviceId:fixture.serviceId,startsAt:slot.startsAt,...(slot.staff?{membershipId:slot.staff.id}:{})}],
          guest:{manageToken:state.manageToken,bookingSmsConsent:false,customer:{name:'Deposit waiver browser QA',email:'waiver-browser-qa@example.test',phoneE164:'+12025550129'}}}};
      await save();
    }
    const response=await fetch('http://127.0.0.1:3087/v1/commands/commerce.holdAppointment',{method:'POST',
      headers:{'content-type':'application/json',authorization:`Bearer ${login.access_token}`,'x-membership-id':m.id},
      body:JSON.stringify({input:state.input,idempotencyKey:`waiver-browser:${state.businessKey}:hold`})});
    const body=await response.json() as {result:{holdId:string;appointmentId:string};code?:string;details?:{reason:string}};
    if(!response.ok)throw new Error(`QA hold failed ${response.status} ${body.code??''} ${body.details?.reason??''}`);
    Object.assign(state,body.result);await save();
    const authPath='/tmp/commerce-desk-auth.json',browser=JSON.parse(await readFile(authPath,'utf8')) as {origins:Array<{origin:string;localStorage:Array<{name:string;value:string}>}>};
    const origin=browser.origins.find(o=>o.origin==='http://localhost:5297'),entry=origin?.localStorage.find(v=>/^sb-.*-auth-token$/.test(v.name));
    if(!origin||!entry)throw new Error('Owned local browser auth state required');
    entry.value=JSON.stringify({...login,expires_at:Math.floor(Date.now()/1000)+login.expires_in});
    await writeFile(authPath,JSON.stringify({cookies:[],origins:[origin]}),{mode:0o600});await chmod(authPath,0o600);
    console.log(JSON.stringify({prepared:true,appointmentId:state.appointmentId,holdId:state.holdId,startsAt:state.startsAt,privateStatePath:path,stripeVerified:false}));
  }else{
    if(!state.holdId||!state.appointmentId)throw new Error('Prepare the original browser fixture first');
    const [facts]=await withTenant(tenant,tx=>tx`select a.status,a.deposit_status,h.status as hold_status,h.amount_cents,h.service_total_cents,h.order_id,h.waiver_reason,h.waived_at::text,
      (select count(*)::int from commerce_deposit_ledger where hold_id=h.id) as money_rows,
      (select count(*)::int from appointment_items where appointment_id=a.id and status='booked') as active_items,
      (select count(*)::int from email_outbox where entity_id=a.id and kind='appointment_confirm' and to_email='waiver-browser-qa@example.test') as confirmation_rows
      from appointments a join commerce_appointment_holds h on h.appointment_id=a.id where h.id=${state.holdId} and a.id=${state.appointmentId}`);
    if(!facts||facts.deposit_status!=='waived'||facts.status!=='booked'||facts.hold_status!=='waived'||facts.money_rows!==0||facts.order_id!==null
      ||facts.service_total_cents!==10000||facts.confirmation_rows!==1||facts.active_items!==1)throw new Error('Browser waiver invariants failed');
    const response=await fetch('http://127.0.0.1:3087/public/v1/hosted/manage',{method:'POST',headers:{'content-type':'application/json',origin:'http://localhost:5296'},
      body:JSON.stringify({slug:'golden-foot',manageToken:state.manageToken,locale:'zh-Hans'})});
    const managed=await response.json() as {booking:{deposit:{status:string;availableCents:number;serviceRemainingCents:number;checkoutUrl:string|null}}};
    if(!response.ok||managed.booking?.deposit.status!=='waived'||managed.booking.deposit.serviceRemainingCents!==10000||managed.booking.deposit.checkoutUrl!==null)throw new Error('Managed waiver summary mismatch');
    const report={at:new Date().toISOString(),browserWaiverVerified:true,actualApi:true,database:'gf_commerce_ci',appointmentId:state.appointmentId,holdId:state.holdId,
      facts,publicSummary:{status:managed.booking.deposit.status,availableCents:managed.booking.deposit.availableCents,serviceRemainingCents:managed.booking.deposit.serviceRemainingCents,hasPaymentAction:false},
      stripeVerified:false,inFlightProviderRefundVerified:false,notificationDelivery:'capture',goalComplete:false};
    await writeFile('artifacts/customer-commerce/browser-deposit-waiver.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
  }
}finally{await closeDb();}
