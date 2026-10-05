// Real test-mode payout acceptance. No production money, invented sources, or direct financial DB writes.
import {randomUUID} from 'node:crypto';
import {readFile,writeFile,chmod} from 'node:fs/promises';
import {assertRegressionTarget} from '../packages/db/src/qa/regressionSafety';
for(const [target,source] of [['DATABASE_URL','TEST_DATABASE_URL'],['MIGRATION_DATABASE_URL','TEST_MIGRATION_DATABASE_URL']] as const){
 const u=new URL(process.env[source]??'');if(!['localhost','127.0.0.1'].includes(u.hostname)||u.port!=='58332')throw new Error('Dedicated preserved QA database required');u.pathname='/gf_commerce_ci';process.env[target]=u.href;
}
process.env.NODE_ENV='test';process.env.COMMUNICATION_DELIVERY_MODE='capture';assertRegressionTarget(process.env);
const key=process.env.COMMERCE_STRIPE_SECRET_KEY?.trim()||process.env.STRIPE_SECRET_KEY||'';
if(process.env.COMMERCE_STRIPE_MODE!=='test'||!key.startsWith('sk_test_'))throw new Error('Explicit sandbox key required');
const mode=process.argv[2],family=process.argv[3]??'original';if(!['probe','create','verify','reconcile','replay','discover-success-bank'].includes(mode??'')||!['original','success'].includes(family))throw new Error('Unknown payout fixture mode/family');
const path=`/tmp/commerce-payout-${family==='success'?'success-':''}sandbox-private.json`,tenant={orgId:'22222222-2222-4222-8222-222222222222',locationId:'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',membershipId:null};
type State={key:string;payoutId?:string;bankId?:string;paymentRows?:number;paymentGross?:number;reconciliations?:number;replays?:number};
let state:State;try{state=JSON.parse(await readFile(path,'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;state={key:randomUUID()};}
async function save(){await writeFile(path,JSON.stringify(state),{mode:0o600});await chmod(path,0o600);}
const {withTenant,closeDb}=await import('../packages/db/src/index');
try{
 const [mapping]=await withTenant(tenant,tx=>tx<{stripe_account_id:string}[]>`select stripe_account_id from commerce_accounts where location_id=${tenant.locationId} and not livemode and charges_enabled and payouts_enabled and not disconnected`);
 if(mapping?.stripe_account_id!=='acct_1ULVaEJDnwwxW56m')throw new Error('Original verified sandbox merchant required');
 const {commerceStripeClient}=await import('../apps/api/src/commerce/client');const stripe=commerceStripeClient(),options={stripeAccount:mapping.stripe_account_id};
 const balance=await stripe.balance.retrieve({},options);if(balance.livemode)throw new Error('Production balance rejected');
 const available=balance.available.find(b=>b.currency==='usd')?.amount??0;
 const banks=await stripe.accounts.listExternalAccounts(mapping.stripe_account_id,{object:'bank_account',limit:100});
 const defaults=banks.data.filter(b=>b.object==='bank_account'&&b.default_for_currency&&b.currency==='usd');if(defaults.length!==1)throw new Error('Existing default sandbox bank required');
 let bank=state.bankId?banks.data.find(b=>b.id===state.bankId):family==='original'?defaults[0]:undefined;
 if(mode==='discover-success-bank'){
  if(family!=='success')throw new Error('Successful payout QA family required');
  const selected=defaults[0];if(selected?.object!=='bank_account'||selected.last4!=='6789'||selected.status==='errored')throw new Error('Wait for the merchant to select the official successful test bank');state.bankId=selected.id;await save();bank=selected;
  console.log(JSON.stringify({successfulTestBankReadOnlyVerified:true,bankSettingsChangedByFixture:false,productionChanged:false}));
 }
 const [cash]=await withTenant(tenant,tx=>tx<{n:number;gross:number}[]>`select count(*)::int as n,coalesce(sum(amount_cents),0)::int as gross from commerce_payments`);
 if(mode==='probe')console.log(JSON.stringify({readOnly:true,testMode:true,availableUsdCents:available,pendingUsdCents:balance.pending.find(b=>b.currency==='usd')?.amount??0,defaultTestBankCount:defaults.length,payoutAlreadyCreated:!!state.payoutId}));
 async function originalPayout(){
  if(!state.payoutId)throw new Error('Create the one sandbox payout first');const p=await stripe.payouts.retrieve(state.payoutId,{},options);
  if(p.livemode||p.amount!==1000||p.currency!=='usd'||p.automatic||p.metadata?.gf_qa_key!==state.key)throw new Error('Original test payout contract mismatch');
  const destination=typeof p.destination==='string'?p.destination:p.destination?.id;if(!destination||state.bankId&&state.bankId!==destination)throw new Error('Original payout destination mismatch');
  if(!state.bankId){state.bankId=destination;await save();}bank=banks.data.find(b=>b.id===state.bankId);return p;
 }
 if(mode==='create'){
  if(!state.payoutId){
   const purchase=JSON.parse(await readFile('/tmp/commerce-package-payout-private.json','utf8')) as {orderId?:string};
   const [funded]=await withTenant(tenant,tx=>tx`select p.id from commerce_payments p join commerce_orders o on o.id=p.order_id where o.id=${purchase.orderId??''} and o.kind='package' and p.status='paid' and p.amount_cents=50000 and not p.livemode and o.asset_id is not null and p.balance_transaction_id is not null`);
   if(!funded||available<1000||!bank)throw new Error('Actual package payment, selected test bank and available sandbox funds required');
   state.paymentRows=cash!.n;state.paymentGross=cash!.gross;await save();
   state.bankId=bank.id;await save();const p=await stripe.payouts.create({amount:1000,currency:'usd',destination:bank.id,metadata:{gf_domain:'customer_commerce',gf_qa_key:state.key}},{...options,idempotencyKey:`gf-commerce-payout-qa:${state.key}`});
   state.payoutId=p.id;await save();
  }
  const p=await originalPayout();console.log(JSON.stringify({actualTestPayoutCreated:true,amountCents:p.amount,status:p.status,automatic:p.automatic,productionChanged:false}));
 }
 if(mode==='replay'){
  const original=await originalPayout();if(!bank)throw new Error('Original test bank required');if(Date.now()/1000-original.created>=23*3600)throw new Error('Creation replay window expired; preserve and retrieve the original payout');
  const p=await stripe.payouts.create({amount:1000,currency:'usd',destination:bank.id,metadata:{gf_domain:'customer_commerce',gf_qa_key:state.key}},{...options,idempotencyKey:`gf-commerce-payout-qa:${state.key}`});
  if(p.id!==original.id)throw new Error('Payout creation replay changed identity');state.replays=(state.replays??0)+1;await save();console.log(JSON.stringify({originalPayoutReused:true,replayRuns:state.replays}));
 }
 if(mode==='reconcile'){
  const p=await originalPayout();const {reconcilePayout}=await import('../apps/api/src/commerce/payouts');for(let run=0;run<3;run++)await reconcilePayout(mapping.stripe_account_id,false,p.id);state.reconciliations=(state.reconciliations??0)+3;await save();console.log(JSON.stringify({actualSdkReconciliationRuns:state.reconciliations}));
 }
 if(mode==='verify'){
  const p=await originalPayout(),idOf=(value:unknown)=>typeof value==='string'?value:value&&typeof value==='object'&&'id' in value?String(value.id):null;
  const debitId=idOf(p.balance_transaction);if(!debitId)throw new Error('Wait for actual payout debit');const debit=await stripe.balanceTransactions.retrieve(debitId,{},options);
  if(debit.id!==debitId||debit.currency!=='usd'||debit.amount!==-1000||debit.net!==-1000||debit.fee!==0||idOf(debit.source)!==p.id)throw new Error('Actual payout debit mismatch');
  const rows=await withTenant(tenant,tx=>tx`select p.id,p.amount_cents,p.automatic,o.status,o.source_count from commerce_payouts p join lateral(select * from commerce_payout_observations where payout_id=p.id order by observed_at desc,created_at desc,id desc limit 1)o on true where p.stripe_payout_id=${p.id} and not p.livemode`);
  if(rows.length!==1||rows[0]!.status!==p.status||rows[0]!.amount_cents!==1000||rows[0]!.automatic||rows[0]!.source_count!==null)throw new Error('Wait for genuine payout callback/current SDK facts');const local=rows[0]!;
  const transactions=await withTenant(tenant,tx=>tx`select role,gross_cents,fee_cents,net_cents from commerce_payout_transactions where payout_id=${local.id} order by role`);
  const debits=transactions.filter(t=>t.role==='debit'),returns=transactions.filter(t=>t.role==='reversal');
  if(debits.length!==1||debits[0]!.net_cents!==-1000||transactions.some(t=>t.role==='source'))throw new Error('Actual payout debit/source mismatch');
  if(['failed','canceled'].includes(p.status)){
   const returnId=idOf(p.failure_balance_transaction);if(!returnId)throw new Error('Wait for actual bank return');const returned=await stripe.balanceTransactions.retrieve(returnId,{},options);
   if(returned.id!==returnId||returned.currency!=='usd'||returned.amount!==1000||returned.fee!==0||returned.net!==1000||idOf(returned.source)!==p.id||returns.length!==1||returns[0]!.net_cents!==1000)throw new Error('Actual bank return mismatch');
  }else if(returns.length)throw new Error('Unexpected bank return');
  const events=await withTenant(tenant,tx=>tx`select event_type,count(*)::int as n from commerce_events where object_id=${p.id} and left(event_id,4)='evt_' group by event_type order by event_type`);
  if(!events.length||cash!.n!==state.paymentRows||cash!.gross!==state.paymentGross)throw new Error('Genuine callback and preserved customer cash required');
  const tasks=await withTenant(tenant,tx=>tx`select kind,status,retry_at is not null as scheduled from commerce_tasks where subject_id=${local.id} and kind='payout_reconcile'`);
  if(tasks.length!==1||tasks[0]!.status==='review'||!tasks[0]!.scheduled)throw new Error('Durable payout reconciliation required');
  const scan=await withTenant(tenant,tx=>tx`select t.kind,t.status,t.last_error,a.payout_scan_cursor,t.retry_at>now() as scheduled from commerce_tasks t join commerce_accounts a on a.id=t.subject_id where t.kind='payout_scan' and a.stripe_account_id=${mapping.stripe_account_id} and not a.livemode`);
  const scanCommands=await withTenant(tenant,tx=>tx`select command,count(*)::int as n from command_idempotency where command in('commerce.refreshPayouts','commerce.savePayoutScan','commerce.renewTaskLease') group by command order by command`);
  if(scan.length!==1||scan[0]!.status!=='pending'||scan[0]!.last_error||scan[0]!.payout_scan_cursor!==null||!scan[0]!.scheduled||scanCommands.length!==3)throw new Error('Actual native refresh, persisted scan completion and lease renewal required');
  const foreign=await withTenant({orgId:'11111111-1111-4111-8111-111111111111',locationId:'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',membershipId:null},tx=>tx`select id from commerce_payouts where id=${local.id}`);if(foreign.length)throw new Error('Payout tenant isolation failed');
  const report={at:new Date().toISOString(),scope:'One actual manual test payout from the original merchant; no customer income duplication',actualStripeSandbox:true,localPayoutId:local.id,amountCents:p.amount,currency:p.currency,status:p.status,failureCode:p.failure_code,automatic:p.automatic,reconciliationStatus:p.reconciliation_status,arrivalAt:new Date(p.arrival_date*1000).toISOString(),bankReceiptClaimed:false,manualSourcesNotInvented:true,transactions,signedEvents:events,tasks,scan,scanCommands,customerPaymentRowsUnchanged:true,customerPaymentGrossUnchanged:true,foreignRows:foreign.length,creationReplayRuns:state.replays??0,sdkReconciliationRuns:state.reconciliations??0,availableUsdCents:available,productionChanged:false};
  await writeFile(`artifacts/customer-commerce/p1-payout-${family==='success'?'success-':''}sandbox.json`,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
 }
}catch(e){console.error(JSON.stringify({failed:true,mode,code:(e as {code?:string}).code??'fixture_validation_failed',reason:(e as {type?:string}).type?'provider_request_failed':e instanceof Error?e.message:'unknown'}));process.exitCode=1;}finally{await closeDb();}
