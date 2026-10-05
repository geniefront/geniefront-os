// Real local voice-tool HTTP -> isolated database -> actual sandbox Checkout / browser cash record.
// The fixture does not represent a physical telephone conversation or send real customer messages.
import {readFile,writeFile,chmod} from 'node:fs/promises';
import {assertRegressionTarget} from '../packages/db/src/qa/regressionSafety';
for(const [target,source] of [['DATABASE_URL','TEST_DATABASE_URL'],['MIGRATION_DATABASE_URL','TEST_MIGRATION_DATABASE_URL']] as const){
  const url=new URL(process.env[source]??'');if(!['localhost','127.0.0.1'].includes(url.hostname)||url.port!=='58332')throw new Error('Dedicated commerce QA database required');
  url.pathname='/gf_commerce_ci';process.env[target]=url.href;
}
assertRegressionTarget(process.env);
if(process.env.COMMERCE_STRIPE_MODE!=='test'||!['localhost','127.0.0.1'].includes(new URL(process.env.SUPABASE_URL!).hostname)
  ||process.env.COMMUNICATION_DELIVERY_MODE&&process.env.COMMUNICATION_DELIVERY_MODE!=='capture')throw new Error('Local capture/test mode required');
process.env.NODE_ENV='test';process.env.COMMUNICATION_DELIVERY_MODE='capture';
const action=process.argv[2],scenario=process.argv[3]??'online';
if(!['prepare','verify'].includes(action??'')||!['online','offline','pending-ui'].includes(scenario))throw new Error('Expected prepare|verify online|offline|pending-ui');
const tenant={orgId:'22222222-2222-4222-8222-222222222222',locationId:'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'},phone='+12025550770';
const path=`/tmp/commerce-voice-${scenario}-private.json`,linePath='/tmp/commerce-voice-line-private.json';
type State={input?:Record<string,unknown>;appointmentId?:string;holdId?:string;orderId?:string|null;manageToken?:string};
let state:State;try{state=JSON.parse(await readFile(path,'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;state={};}
let line:{key:string;token?:string};try{line=JSON.parse(await readFile(linePath,'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;line={key:crypto.randomUUID()};}
async function save(file:string,value:unknown){await writeFile(file,JSON.stringify(value),{mode:0o600});await chmod(file,0o600);}
const {withTenant,closeDb}=await import('../packages/db/src/index');
const {buildContext}=await import('../apps/api/src/actor');const {dispatch}=await import('../apps/api/src/bus');
await import('../apps/api/src/handlers/setup');await import('../apps/api/src/handlers/phone');
const submit=async()=>{
  const response=await fetch(`http://127.0.0.1:3087/v1/voice/${encodeURIComponent(phone)}/bookings-v2`,{method:'POST',
    headers:{authorization:`Bearer ${line.token}`,'content-type':'application/json'},body:JSON.stringify(state.input)});
  const result=await response.json() as {appointmentId:string;bookingConfirmed:boolean;status:string;deposit:{holdId:string;amountCents:number};code?:string;details?:{reason:string}};
  if(!response.ok)throw new Error(`Voice tool ${response.status} ${result.code??''} ${result.details?.reason??''}`);return result;
};
try{
  if(action==='prepare'){
    const auth=await fetch(`${process.env.SUPABASE_URL}/auth/v1/token?grant_type=password`,{method:'POST',headers:{apikey:process.env.SUPABASE_ANON_KEY!,'content-type':'application/json'},
      body:JSON.stringify({email:'qa-local-owner@example.test',password:process.env.GF_BASELINE_PASSWORD})});
    if(!auth.ok)throw new Error('Existing local QA owner login required');const login=await auth.json() as {access_token:string;expires_in:number;user:{id:string}};
    const [m]=await withTenant(tenant,tx=>tx`select id from memberships where user_id=${login.user.id} and location_id=${tenant.locationId} and status='active'`);
    if(!m)throw new Error('QA owner membership missing');const ctx=await buildContext({userId:login.user.id,membershipId:m.id});
    if(!ctx.permissions.has('settings.manage'))throw new Error('QA owner settings permission required');
    if(!line.token){
      await save(linePath,line);
      const out=await dispatch<{toolToken:string}>('location.savePhoneLine',{e164:phone,purpose:'ai_voice',active:true,aiAnswer:true,rotateToolToken:true},ctx,
        {systemOrigin:'local_commerce_voice_qa',idempotencyKey:`commerce-voice-line:${line.key}`});
      line.token=out.result.toolToken;await save(linePath,line);
    }
    if(!state.input){
      const {serviceId}=JSON.parse(await readFile('/tmp/commerce-deposit-sandbox-private.json','utf8')) as {serviceId:string};
      const shop=await fetch('http://127.0.0.1:3087/public/v1/hosted/shops/golden-foot?locale=en');if(!shop.ok)throw new Error('QA shop unavailable');
      const s=await shop.json() as {timezone:string};const {addDays}=await import('../packages/scheduling/src/index');
      const date=addDays(new Intl.DateTimeFormat('en-CA',{timeZone:s.timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()),7);
      const r=await fetch(`http://127.0.0.1:3087/v1/voice/${encodeURIComponent(phone)}/context-v2?${new URLSearchParams({date,serviceId})}`,
        {headers:{authorization:`Bearer ${line.token}`}});if(!r.ok)throw new Error(`Real voice availability failed ${r.status}`);
      const b=await r.json() as {offers:Array<{slotToken:string;times:string[];priceCents:number;deposit:{policyVersion:string;amountCents:number;serviceTotalCents:number}}>};
      const offer=b.offers[0];if(!offer?.deposit||offer.priceCents!==10000||offer.deposit.amountCents!==2000)throw new Error('Expected original $100 service / current $20 deposit; do not override policy or capacity');
      const time=offer.times[0]!.split(/[-,/]/)[0]!;
      state.input={slotToken:offer.slotToken,time,customerName:scenario==='online'?'Voice online deposit browser QA':'Voice frontdesk deposit browser QA',
        phoneE164:scenario==='online'?'+12025550771':scenario==='pending-ui'?'+12025550773':'+12025550772',...(scenario==='online'?{email:'voice-online-browser-qa@example.test'}:{}),
        priceConfirmed:true,confirmedTotalCents:offer.priceCents,depositConsent:{accepted:true,policyVersion:offer.deposit.policyVersion,
          amountCents:offer.deposit.amountCents,serviceTotalCents:offer.deposit.serviceTotalCents}};
      await save(path,state);
    }
    const result=await submit();if(result.bookingConfirmed||result.status!=='pending_deposit')throw new Error('Prepared voice booking must await actual payment');
    state.appointmentId=result.appointmentId;state.holdId=result.deposit.holdId;
    const [h]=await withTenant(tenant,tx=>tx`select h.order_id,a.manage_token_wrapped,a.manage_token_digest from commerce_appointment_holds h
      join appointments a on a.id=h.appointment_id where h.id=${state.holdId!}`);
    const {unwrapManageToken}=await import('../apps/api/src/public/bookingToken');
    state.orderId=h!.order_id;state.manageToken=unwrapManageToken(h!.manage_token_wrapped,h!.manage_token_digest)??undefined;
    if(scenario==='online'&&!state.orderId||scenario==='offline'&&state.orderId)throw new Error('Voice payment channel mismatch');
    await save(path,state);
    const authPath='/tmp/commerce-desk-auth.json',browser=JSON.parse(await readFile(authPath,'utf8')) as {origins:Array<{origin:string;localStorage:Array<{name:string;value:string}>}>};
    const origin=browser.origins.find(o=>o.origin==='http://localhost:5297'),entry=origin?.localStorage.find(v=>/^sb-.*-auth-token$/.test(v.name));
    if(!origin||!entry)throw new Error('Owned browser auth state missing');entry.value=JSON.stringify({...login,expires_at:Math.floor(Date.now()/1000)+login.expires_in});
    await save(authPath,{cookies:[],origins:[origin]});
    const [pendingFacts]=await withTenant(tenant,tx=>tx`select a.source,a.deposit_status,h.status as hold_status,h.service_total_cents,h.amount_cents,
      (select count(*)::int from commerce_deposit_ledger where hold_id=h.id and entry='collected') as collected_rows,
      (select count(*)::int from email_outbox where entity_id=a.id and kind='appointment_confirm') as confirmation_rows,
      (select count(*)::int from email_outbox where entity_id=a.id and kind='appointment_deposit_pending') as request_rows,
      (select count(*)::int from email_outbox where entity_id=a.id and kind='appointment_deposit_pending' and status='captured') as captured_request_rows
      from appointments a join commerce_appointment_holds h on h.appointment_id=a.id where a.id=${state.appointmentId!}`);
    if(pendingFacts!.collected_rows||pendingFacts!.confirmation_rows)throw new Error('Unpaid hold must not collect money or confirm');
    await writeFile(`artifacts/customer-commerce/browser-voice-deposit-${scenario}-pending.json`,JSON.stringify({at:new Date().toISOString(),scenario,
      actualVoiceToolHttp:true,physicalPhoneConversationVerified:false,bookingConfirmed:false,realEmailDeliveryVerified:false,
      appointmentId:state.appointmentId,holdId:state.holdId,facts:pendingFacts},null,2)+'\n');
    console.log(JSON.stringify({scenario,prepared:true,actualVoiceToolHttp:true,physicalPhoneConversationVerified:false,
      appointmentId:state.appointmentId,holdId:state.holdId,amountCents:2000,bookingConfirmed:false,privateStatePath:path}));
  }else{
    if(!state.appointmentId||!state.holdId)throw new Error('Original prepared voice story required');
    const result=await submit();
    const [facts]=await withTenant(tenant,tx=>tx`select a.source,a.status,a.deposit_status,h.status as hold_status,h.amount_cents,h.service_total_cents,
      h.policy_snapshot->'consent' as consent,p.provider,p.external_reference,p.recorded_by,p.checkout_session_id,p.stripe_account_id,
      p.fee_cents,p.net_cents,p.balance_transaction_id,
      (select count(*)::int from commerce_events where object_id=p.checkout_session_id and event_id like 'evt_%' and event_type='checkout.session.completed') as signed_checkout_events,
      (select count(*)::int from commerce_deposit_ledger where hold_id=h.id and entry='collected') as collected_rows,
      (select sum(amount_cents)::int from commerce_deposit_ledger where hold_id=h.id) as deposit_balance_cents,
      (select count(*)::int from email_outbox where entity_id=a.id and kind='appointment_confirm') as confirmation_rows,
      (select count(*)::int from email_outbox where entity_id=a.id and kind='appointment_deposit_pending') as request_rows,
      (select count(*)::int from email_outbox where entity_id=a.id and kind='appointment_deposit_pending' and status='captured') as captured_request_rows
      from appointments a join commerce_appointment_holds h on h.appointment_id=a.id left join commerce_payments p on p.order_id=h.order_id
      where a.id=${state.appointmentId!} and h.id=${state.holdId!}`);
    if(!facts||facts.source!=='phone_ai'||facts.status!=='booked'||facts.deposit_status!=='paid'||facts.amount_cents!==2000||facts.service_total_cents!==10000
      ||facts.collected_rows!==1||facts.deposit_balance_cents!==2000||facts.confirmation_rows!==(scenario==='online'?1:0)
      ||!result.bookingConfirmed)throw new Error('Actual voice deposit financial invariants failed (email confirmation requires an address)');
    let stripeVerified=false;
    if(scenario==='online'){
      const {commerceStripeClient}=await import('../apps/api/src/commerce/client');
      const s=await commerceStripeClient().checkout.sessions.retrieve(facts.checkout_session_id,{}, {stripeAccount:facts.stripe_account_id});
      if(s.livemode||s.status!=='complete'||s.payment_status!=='paid'||s.amount_total!==2000||s.currency!=='usd'||s.metadata?.gf_order_id!==state.orderId
        ||s.metadata.gf_domain!=='customer_commerce'||s.metadata.gf_org_id!==tenant.orgId||s.metadata.gf_location_id!==tenant.locationId
        ||s.client_reference_id!==state.orderId||facts.signed_checkout_events<1)throw new Error('Actual original sandbox Checkout and signed event must match');
      stripeVerified=true;
    }else if(facts.provider!=='offline'||!facts.external_reference||!facts.recorded_by)throw new Error('Staff-recorded cash receipt required');
    const report={at:new Date().toISOString(),scenario,actualVoiceToolHttp:true,browserPaymentVerified:true,
      physicalPhoneConversationVerified:false,realEmailDeliveryVerified:false,physicalCashVerified:false,deliveryMode:'capture',stripeVerified,
      appointmentId:state.appointmentId,holdId:state.holdId,facts,authoritativeReplay:{status:result.status,bookingConfirmed:result.bookingConfirmed},
      serviceConsumed:false,bankPayoutVerified:false,goalComplete:false};
    await writeFile(`artifacts/customer-commerce/browser-voice-deposit-${scenario}.json`,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
  }
}finally{await closeDb();}
