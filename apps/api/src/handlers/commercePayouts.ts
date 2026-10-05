import {createHash} from 'node:crypto';
import {AppError,ERROR_CODES,CommerceRecordPayout,CommerceRecordPayoutTransaction,CommerceRefreshPayouts,CommerceSavePayoutScan,CommerceRenewTaskLease} from '@gf/contracts';
import {commerceFingerprint} from '@gf/payroll';
import {businessDateOf} from '@gf/scheduling';
import {registerHandler} from '../bus';
import {commerceLiveMode} from '../commerce/config';
function invalid(reason:string):never{throw new AppError(ERROR_CODES.VALIDATION_FAILED,{details:{reason}});}
registerHandler(CommerceRenewTaskLease,async({tx,input,audit})=>{
 const rows=await tx`update commerce_tasks set locked_until=now()+interval '2 minutes' where id=${input.taskId} and lease_id=${input.leaseId} and status='processing' returning id`;
 audit({entityType:'commerce_task',entityId:input.taskId,after:{leaseRenewed:!!rows.length}});return {renewed:!!rows.length};
});
registerHandler(CommerceRefreshPayouts,async({tx,ctx,audit})=>{
 const [account]=await tx<{id:string}[]>`select id from commerce_accounts where location_id=${ctx.locationId} and livemode=${commerceLiveMode()} for update`;
 if(!account)throw new AppError(ERROR_CODES.NOT_FOUND);
 await tx`insert into commerce_tasks(org_id,location_id,kind,subject_id,retry_at) values(${ctx.orgId},${ctx.locationId},'payout_scan',${account.id},now())
  on conflict(kind,subject_id) do update set status=case when commerce_tasks.status='processing' then 'processing' else 'pending' end,retry_at=now(),attempts=0,last_error=null`;
 audit({entityType:'commerce_account',entityId:account.id,after:{payoutRefreshQueued:true}});return {queued:true};
});
registerHandler(CommerceSavePayoutScan,async({tx,input,audit})=>{
 const [a]=await tx<{payout_scan_cursor:string|null}[]>`select payout_scan_cursor from commerce_accounts where id=${input.accountId} for update`;
 if(!a)throw new AppError(ERROR_CODES.NOT_FOUND);if(a.payout_scan_cursor!==input.expectedCursor)invalid('payout_scan_cursor_changed');
 await tx`update commerce_accounts set payout_scan_cursor=${input.nextCursor} where id=${input.accountId}`;
 audit({entityType:'commerce_account',entityId:input.accountId,after:{payoutPageCompleted:true}});return {saved:true};
});
registerHandler(CommerceRecordPayout,async({tx,ctx,input,audit})=>{
 const [account]=await tx<{id:string;timezone:string;cutoff:string}[]>`select a.id,l.timezone,l.business_day_cutoff::text as cutoff from commerce_accounts a
  join locations l on l.id=a.location_id where a.location_id=${ctx.locationId} and a.org_id=${ctx.orgId} and a.stripe_account_id=${input.stripeAccountId} and a.livemode=${input.livemode} for update of a`;
 if(!account)invalid('payout_account_mismatch');
 const businessDate=businessDateOf(new Date(input.createdAt),account.timezone,account.cutoff);
 const [p]=await tx<{id:string;amount_cents:number;currency:string;automatic:boolean;provider_created_at:Date;destination_type:string}[]>`insert into commerce_payouts(org_id,location_id,account_id,stripe_account_id,livemode,stripe_payout_id,
  amount_cents,currency,automatic,destination_type,provider_created_at,business_date)
  values(${ctx.orgId},${ctx.locationId},${account.id},${input.stripeAccountId},${input.livemode},${input.payoutId},${input.amountCents},${input.currency},${input.automatic},${input.destinationType},${input.createdAt}::timestamptz,${businessDate})
  on conflict(stripe_account_id,livemode,stripe_payout_id) do nothing returning *`;
 const existing=p??(await tx<typeof p[]>`select * from commerce_payouts where stripe_account_id=${input.stripeAccountId} and livemode=${input.livemode} and stripe_payout_id=${input.payoutId}`)[0];
 if(!existing||existing.amount_cents!==input.amountCents||existing.currency!==input.currency||existing.automatic!==input.automatic
  ||existing.destination_type!==input.destinationType||new Date(existing.provider_created_at).toISOString()!==input.createdAt)invalid('payout_identity_changed');
 if(input.event){
  await tx`insert into commerce_events(org_id,location_id,stripe_account_id,livemode,event_id,event_type,object_id)
   values(${ctx.orgId},${ctx.locationId},${input.stripeAccountId},${input.livemode},${input.event.id},${input.event.type},${input.payoutId}) on conflict do nothing`;
  const [prior]=await tx<{object_id:string;event_type:string}[]>`select object_id,event_type from commerce_events where stripe_account_id=${input.stripeAccountId} and livemode=${input.livemode} and event_id=${input.event.id}`;
  if(prior?.object_id!==input.payoutId||prior.event_type!==input.event.type)invalid('payout_event_identity_changed');
 }
 if(input.sourceCount!==null||input.sourceNetCents!==null){
  const [sources]=await tx<{n:number;net:number}[]>`select count(*)::int as n,coalesce(sum(net_cents),0)::int as net from commerce_payout_transactions where payout_id=${existing.id} and role='source'`;
  if(!input.automatic||input.reconciliationStatus!=='completed'||sources!.n!==input.sourceCount||sources!.net!==input.sourceNetCents||input.sourceNetCents!==input.amountCents)invalid('payout_source_batch_mismatch');
 }
 const state={status:input.status,reconciliationStatus:input.reconciliationStatus,arrivalAt:input.arrivalAt,failureCode:input.failureCode,sourceCount:input.sourceCount,sourceNetCents:input.sourceNetCents,
  balanceTransactionId:input.balanceTransactionId,failureBalanceTransactionId:input.failureBalanceTransactionId};
 const hash=createHash('sha256').update(commerceFingerprint(state)).digest('hex');
 const inserted=await tx`insert into commerce_payout_observations(org_id,location_id,payout_id,status,reconciliation_status,arrival_at,failure_code,
  balance_transaction_id,failure_balance_transaction_id,observed_at,facts_hash,source_count,source_net_cents)
  values(${ctx.orgId},${ctx.locationId},${existing.id},${input.status},${input.reconciliationStatus},${input.arrivalAt}::timestamptz,${input.failureCode},
   ${input.balanceTransactionId},${input.failureBalanceTransactionId},${input.observedAt}::timestamptz,${hash},${input.sourceCount},${input.sourceNetCents}) on conflict(payout_id,facts_hash) do nothing returning id`;
 if(inserted.length)await tx`insert into commerce_tasks(org_id,location_id,kind,subject_id,retry_at)
  values(${ctx.orgId},${ctx.locationId},'payout_reconcile',${existing.id},now()+interval '1 minute') on conflict(kind,subject_id) do update
  set status=case when commerce_tasks.status='processing' then 'processing' else 'pending' end,retry_at=least(commerce_tasks.retry_at,excluded.retry_at)`;
 audit({entityType:'commerce_payout',entityId:existing.id,after:{status:input.status,accountScoped:true,bankConfirmed:false}});
 return {payoutId:existing.id,recorded:!!inserted.length};
});
registerHandler(CommerceRecordPayoutTransaction,async({tx,input,audit})=>{
 const [p]=await tx<{id:string;stripe_account_id:string;livemode:boolean}[]>`select id,stripe_account_id,livemode from commerce_payouts where id=${input.payoutId}`;
 if(!p||p.stripe_account_id!==input.stripeAccountId||p.livemode!==input.livemode||input.netCents!==input.grossCents-input.feeCents)invalid('payout_balance_context_mismatch');
 const [prior]=await tx`select role,balance_transaction_id,source_id,currency,gross_cents,fee_cents,net_cents,type,provider_created_at,available_on
  from commerce_payout_transactions where payout_id=${p.id} and balance_transaction_id=${input.balanceTransactionId}`;
 if(prior&&(prior.role!==input.role||prior.source_id!==input.sourceId||prior.currency!==input.currency||prior.gross_cents!==input.grossCents||prior.fee_cents!==input.feeCents
  ||prior.net_cents!==input.netCents||prior.type!==input.type||new Date(prior.provider_created_at).toISOString()!==input.createdAt||new Date(prior.available_on).toISOString()!==input.availableOn))invalid('payout_balance_fact_changed');
 const inserted=await tx`insert into commerce_payout_transactions(org_id,location_id,payout_id,role,balance_transaction_id,source_id,currency,gross_cents,fee_cents,net_cents,type,provider_created_at,available_on)
  select org_id,location_id,id,${input.role},${input.balanceTransactionId},${input.sourceId},${input.currency},${input.grossCents},${input.feeCents},${input.netCents},${input.type},${input.createdAt}::timestamptz,${input.availableOn}::timestamptz
  from commerce_payouts where id=${p.id} on conflict(payout_id,balance_transaction_id) do nothing returning id`;
 audit({entityType:'commerce_payout',entityId:p.id,after:{balanceFactRecorded:!!inserted.length,role:input.role}});return {recorded:!!inserted.length};
});
