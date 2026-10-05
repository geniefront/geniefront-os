import { randomUUID } from 'node:crypto';
import { withTenant,sql } from '@gf/db';
import type { FastifyInstance } from 'fastify';
import { dispatch } from '../bus';
import { createCommerceCheckout,submitCommerceRefund,expireCommerceCheckout } from './provider';
import type { Ctx } from './model';
import {reconcileCommerceOrder} from './reconciliation';

export async function runCommerceTask(ctx:Ctx,taskId?:string):Promise<boolean> {
  const leaseId=randomUUID();
  const opts={systemOrigin:'commerce_task_worker'};
  const claimed=await dispatch<{task:{id:string;kind:string;subjectId:string;leaseId:string}|null}>('commerce.claimTask',
    {taskId,leaseId},ctx,{...opts,idempotencyKey:`commerce-claim:${leaseId}`});
  const task=claimed.result.task;if(!task)return false;
  try {
    if(task.kind==='checkout') {
      const session=await createCommerceCheckout(ctx,task.subjectId);
      await dispatch('commerce.finishTask',{taskId:task.id,leaseId,session:{id:session.id,url:session.url,
        expiresAt:new Date(session.expires_at*1000).toISOString()}},ctx,{...opts,idempotencyKey:`commerce-task-result:${leaseId}`});
    } else if(task.kind==='expire_checkout') {
      const result=await expireCommerceCheckout(ctx,task.subjectId),session=result.session;
      await dispatch('commerce.finishTask',{taskId:task.id,leaseId,nextRunAfterSec:result.nextRunAfterSec,
        ...(session?{session:{id:session.id,url:session.url,expiresAt:new Date(session.expires_at*1000).toISOString()}}:{})},ctx,
        {...opts,idempotencyKey:`commerce-task-result:${leaseId}`});
      if(session?.payment_status==='paid')await reconcileCommerceOrder(ctx,task.subjectId);
    } else if(task.kind==='refund') {
      const [r]=await withTenant(ctx,tx=>tx<{status:string;amount_cents:number;stripe_account_id:string;livemode:boolean;stripe_refund_id:string|null}[]>`
        select r.status,r.amount_cents,r.stripe_refund_id,p.stripe_account_id,p.livemode from commerce_refunds r
        join commerce_payments p on p.id=r.payment_id where r.id=${task.subjectId}`);
      if(!r)throw new Error('refund_missing');
      if(r.status==='pending') {
        const result=await submitCommerceRefund(ctx,task.subjectId);
        const status=result.status==='succeeded'?'succeeded':result.status==='failed'||result.status==='canceled'?'failed':'pending';
        await dispatch('commerce.completeRefund',{refundId:task.subjectId,stripeRefundId:result.id,status,
          stripeAccountId:r.stripe_account_id,livemode:r.livemode,amountCents:result.amount},ctx,
          {...opts,idempotencyKey:`commerce-refund-result:${result.id}:${status}`});
        // Pending provider refunds retain their reservation until webhook or reconciliation.
      }
      await dispatch('commerce.finishTask',{taskId:task.id,leaseId},ctx,{...opts,idempotencyKey:`commerce-task-result:${leaseId}`});
    } else if(task.kind==='expire_deposit_request') {
      await dispatch('commerce.expireDepositRequest',{orderId:task.subjectId},ctx,{...opts,idempotencyKey:`commerce-request-expiry:${task.subjectId}`});
      await dispatch('commerce.finishTask',{taskId:task.id,leaseId},ctx,{...opts,idempotencyKey:`commerce-task-result:${leaseId}`});
    } else if(task.kind==='expire_deposit') {
      await dispatch('commerce.expireAppointmentHold',{holdId:task.subjectId},ctx,
        {...opts,idempotencyKey:`commerce-deposit-expiry:${task.subjectId}`});
      await dispatch('commerce.finishTask',{taskId:task.id,leaseId},ctx,{...opts,idempotencyKey:`commerce-task-result:${leaseId}`});
    } else if(task.kind==='membership_grant') {
      const result=await dispatch<{issued:number;nextRunAfterSec?:number}>('commerce.grantMembershipCycles',{membershipId:task.subjectId},ctx,
        {...opts,idempotencyKey:`membership-grant:${leaseId}`});
      await dispatch('commerce.finishTask',{taskId:task.id,leaseId,nextRunAfterSec:result.result.nextRunAfterSec},ctx,
        {...opts,idempotencyKey:`commerce-task-result:${leaseId}`});
    } else if(task.kind==='membership_change_withdraw') {
      await (await import('./membershipChangeWithdrawal')).withdrawMembershipChange(ctx,task.subjectId);
      await dispatch('commerce.finishTask',{taskId:task.id,leaseId},ctx,{...opts,idempotencyKey:`commerce-task-result:${leaseId}`});
    } else if(task.kind==='membership_change') {
      await (await import('./membershipChanges')).scheduleMembershipChange(ctx,task.subjectId);
      await dispatch('commerce.finishTask',{taskId:task.id,leaseId},ctx,{...opts,idempotencyKey:`commerce-task-result:${leaseId}`});
    } else if(task.kind==='subscription_update') {
      await (await import('./customerMembership')).cancelMembershipForTermination(ctx,task.subjectId);
      await dispatch('commerce.finishTask',{taskId:task.id,leaseId},ctx,{...opts,idempotencyKey:`commerce-task-result:${leaseId}`});
    } else if(task.kind==='payout_scan'||task.kind==='payout_reconcile') {
      const payouts=await import('./payouts');
      let renewedAt=0;
      const progress=async()=>{if(Date.now()-renewedAt<20000)return;const renewed=await dispatch<{renewed:boolean}>('commerce.renewTaskLease',{taskId:task.id,leaseId},ctx,
        {...opts,idempotencyKey:`commerce-task-renew:${leaseId}:${randomUUID()}`});if(!renewed.result.renewed)throw new Error('commerce_task_lease_lost');renewedAt=Date.now();};
      const result=task.kind==='payout_scan'?await payouts.scanPayoutPage(ctx,task.subjectId,progress):await payouts.reconcileStoredPayout(ctx,task.subjectId,progress);
      await dispatch('commerce.finishTask',{taskId:task.id,leaseId,nextRunAfterSec:result.nextRunAfterSec},ctx,{...opts,idempotencyKey:`commerce-task-result:${leaseId}`});
    } else if(task.kind==='reconcile') {
      const nextRunAfterSec=await reconcileCommerceOrder(ctx,task.subjectId);
      await dispatch('commerce.finishTask',{taskId:task.id,leaseId,nextRunAfterSec},ctx,
        {...opts,idempotencyKey:`commerce-task-result:${leaseId}`});
    } else throw new Error('unsupported_commerce_task');
  } catch(error) {
    if(task.kind==='checkout'&&(error as {details?:{reason?:string}}).details?.reason==='deposit_hold_expired'){
      await dispatch('commerce.finishTask',{taskId:task.id,leaseId},ctx,{...opts,idempotencyKey:`commerce-task-result:${leaseId}`});return true;
    }
    // Do not persist full provider responses, tokens, URLs, or customer data.
    const code=typeof error==='object'&&error!==null&&'code' in error?String(error.code):'commerce_task_failed';
    await dispatch('commerce.finishTask',{taskId:task.id,leaseId,error:code.slice(0,120)},ctx,
      {...opts,idempotencyKey:`commerce-task-failure:${leaseId}`});
  }
  return true;
}
export function workerContext(orgId:string,locationId:string):Ctx {
  return {orgId,locationId,userId:null,membershipId:null,actorKind:'system',permissions:new Set(),locale:'en',timezone:'UTC'};
}
export function startCommerceWorker(app:FastifyInstance):void {
  if(process.env.GF_CUSTOMER_COMMERCE_WORKER_ENABLED==='0')return;
  let running=false;
  const tick=async()=>{
    if(running)return;running=true;
    try {
      const tenants=await sql<{org_id:string;location_id:string}[]>`select * from commerce_internal.pending_tenants()`;
      for(const tenant of tenants)await runCommerceTask(workerContext(tenant.org_id,tenant.location_id));
    } catch(error){app.log.error({code:(error as {code?:string}).code??'commerce_worker_failed'},'commerce worker failed');}
    finally{running=false;}
  };
  const timer=setInterval(()=>void tick(),10_000);timer.unref();void tick();
  app.addHook('onClose',async()=>{clearInterval(timer);});
}
