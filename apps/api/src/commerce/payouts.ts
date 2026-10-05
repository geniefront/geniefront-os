import {createHash,randomUUID} from 'node:crypto';
import type Stripe from 'stripe';
import {withTenant,sql} from '@gf/db';
import {AppError,ERROR_CODES} from '@gf/contracts';
import {commerceFingerprint} from '@gf/payroll';
import {dispatch} from '../bus';
import {commerceStripeClient} from './client';
import {commerceLiveMode} from './config';
import {workerContext} from './worker';
import type {Ctx} from './model';
import '../handlers/commercePayouts';
const idOf=(v:unknown):string|null=>typeof v==='string'?v:v&&typeof v==='object'&&'id' in v?String(v.id):null;
const time=(v:number)=>new Date(v*1000).toISOString();
function invalid(reason:string):never{throw new AppError(ERROR_CODES.VALIDATION_FAILED,{details:{reason}});}
/** Always retrieve inside the mapped merchant; webhook objects are notification hints, not trusted balance facts. */
export async function reconcilePayout(account:string,livemode:boolean,payoutId:string,event?:{id:string;type:string},progress?:()=>Promise<void>){
 if(livemode!==commerceLiveMode())invalid('payout_wrong_mode');
 const tenants=await sql<{org_id:string;location_id:string}[]>`select * from commerce_internal.account_tenants(${account},${livemode})`;
 if(!tenants.length)return 'ignored_unmapped_account';
 if(new Set(tenants.map(t=>t.org_id)).size!==1)invalid('payout_account_cross_org_mapping');
 const canonical=[...tenants].sort((a,b)=>a.location_id.localeCompare(b.location_id))[0]!;
 let ctx=workerContext(canonical.org_id,canonical.location_id);
 const [existing]=await withTenant(ctx,tx=>tx<{org_id:string;location_id:string}[]>`select org_id,location_id from commerce_payouts where stripe_account_id=${account} and livemode=${livemode} and stripe_payout_id=${payoutId}`);
 if(existing)ctx=workerContext(existing.org_id,existing.location_id);
 const stripe=commerceStripeClient(),options={stripeAccount:account},observedAt=new Date().toISOString();
 await progress?.();
 const p=await stripe.payouts.retrieve(payoutId,{},options);await progress?.();
 if(p.id!==payoutId||p.livemode!==livemode)invalid('payout_provider_context_mismatch');
 const input={stripeAccountId:account,livemode,payoutId:p.id,amountCents:p.amount,currency:p.currency,automatic:p.automatic,destinationType:p.type,
  createdAt:time(p.created),arrivalAt:time(p.arrival_date),observedAt,status:p.status,reconciliationStatus:p.reconciliation_status,failureCode:p.failure_code,
  balanceTransactionId:idOf(p.balance_transaction),failureBalanceTransactionId:idOf(p.failure_balance_transaction),...(event?{event}:{})};
 const hash=createHash('sha256').update(commerceFingerprint({...input,observedAt:null,event:null})).digest('hex');
 const recorded=await dispatch<{payoutId:string}>('commerce.recordPayout',input,ctx,{systemOrigin:event?'commerce_signed_payout_notification':'commerce_retrieved_payout',
  idempotencyKey:event?`commerce-payout-event:${account}:${event.id}:${hash}`:`commerce-payout:${account}:${p.id}:${hash}`});
 async function recordBalance(bt:Stripe.BalanceTransaction,role:'debit'|'reversal'|'source'){
  await progress?.();
  if(bt.currency!==p.currency||bt.net!==bt.amount-bt.fee||role==='debit'&&(bt.amount!==-p.amount||idOf(bt.source)!==p.id)
   ||role==='reversal'&&(bt.amount!==p.amount||idOf(bt.source)!==p.id))invalid('payout_balance_context_mismatch');
  await dispatch('commerce.recordPayoutTransaction',{payoutId:recorded.result.payoutId,stripeAccountId:account,livemode,role,balanceTransactionId:bt.id,sourceId:idOf(bt.source),
   currency:bt.currency,grossCents:bt.amount,feeCents:bt.fee,netCents:bt.net,type:bt.type,createdAt:time(bt.created),availableOn:time(bt.available_on)},ctx,
   {systemOrigin:'commerce_retrieved_payout_balance',idempotencyKey:`commerce-payout-balance:${account}:${p.id}:${bt.id}`});
 }
 for(const [id,role] of [[idOf(p.balance_transaction),'debit'],[idOf(p.failure_balance_transaction),'reversal']] as const){
  if(id){const bt=await stripe.balanceTransactions.retrieve(id,{},options);if(bt.id!==id)invalid('payout_balance_context_mismatch');await recordBalance(bt,role);}
 }
 // Stripe exposes constituent transactions only for automatic payouts. Manual source allocation must never be guessed.
 if(p.automatic&&p.reconciliation_status==='completed'){
  let sourceCount=0,sourceNetCents=0;
  for await(const bt of stripe.balanceTransactions.list({payout:p.id,limit:100},options)){await recordBalance(bt,'source');sourceCount++;sourceNetCents+=bt.net;}
  await dispatch('commerce.recordPayout',{...input,sourceCount,sourceNetCents},ctx,{systemOrigin:'commerce_retrieved_payout_batch',idempotencyKey:`commerce-payout-batch:${account}:${p.id}:${hash}:${sourceCount}:${sourceNetCents}`});
 }
 return {payoutId:recorded.result.payoutId,status:p.status,automatic:p.automatic,reconciliationStatus:p.reconciliation_status,
  nextRunAfterSec:['pending','in_transit'].includes(p.status)||!p.balance_transaction||['failed','canceled'].includes(p.status)&&!p.failure_balance_transaction
   ||p.automatic&&p.status==='paid'&&p.reconciliation_status!=='completed'?60:undefined};
}
export async function scanPayoutPage(ctx:Ctx,accountId:string,progress?:()=>Promise<void>){
 const [a]=await withTenant(ctx,tx=>tx<{stripe_account_id:string;livemode:boolean;payout_scan_cursor:string|null}[]>`select stripe_account_id,livemode,payout_scan_cursor from commerce_accounts where id=${accountId}`);
 if(!a||a.livemode!==commerceLiveMode())invalid('payout_scan_account_mismatch');
 await progress?.();
 const page=await commerceStripeClient().payouts.list({limit:20,...(a.payout_scan_cursor?{starting_after:a.payout_scan_cursor}:{})},{stripeAccount:a.stripe_account_id});await progress?.();
 for(const payout of page.data)await reconcilePayout(a.stripe_account_id,a.livemode,payout.id,undefined,progress);
 await progress?.();
 const nextCursor=page.has_more?page.data.at(-1)?.id??null:null;if(page.has_more&&!nextCursor)invalid('payout_scan_page_inconsistent');
 await dispatch('commerce.savePayoutScan',{accountId,expectedCursor:a.payout_scan_cursor,nextCursor},ctx,
  {systemOrigin:'commerce_retrieved_payout_page',idempotencyKey:`payout-scan:${accountId}:${randomUUID()}`});
 return {nextRunAfterSec:nextCursor?5:3600};
}
export async function reconcileStoredPayout(ctx:Ctx,id:string,progress?:()=>Promise<void>){
 const [p]=await withTenant(ctx,tx=>tx<{stripe_account_id:string;livemode:boolean;stripe_payout_id:string}[]>`select stripe_account_id,livemode,stripe_payout_id from commerce_payouts where id=${id}`);
 if(!p)throw new AppError(ERROR_CODES.NOT_FOUND);
 const result=await reconcilePayout(p.stripe_account_id,p.livemode,p.stripe_payout_id,undefined,progress);
 return typeof result==='string'?{}:{nextRunAfterSec:result.nextRunAfterSec??3600};
}
