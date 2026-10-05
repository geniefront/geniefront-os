import type {Tx} from './model';
import type {Ctx} from './model';
import {withTenant} from '@gf/db';
import {AppError,ERROR_CODES} from '@gf/contracts';
/** Transaction-scoped provider serialization also works through transaction poolers. Never wait holding a pool slot. */
export async function withMembershipProviderLock<T>(ctx:Ctx,membershipId:string,work:()=>Promise<T>):Promise<T>{
 return withTenant(ctx,async tx=>{
  const [lock]=await tx<{locked:boolean}[]>`select pg_try_advisory_xact_lock(hashtextextended(${`commerce-membership-provider:${ctx.orgId}:${ctx.locationId}:${membershipId}`},0)) as locked`;
  if(!lock?.locked)throw new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE,{details:{reason:'membership_provider_busy'}});
  return work();
 });
}
/** Every membership purchase writer locks the parent before its order/payment/refund rows. */
export async function lockMembershipOrder(tx:Tx,orderId:string){
 await tx`select id from customer_paid_memberships where original_order_id=${orderId}
  or id in(select membership_id from customer_membership_invoices where order_id=${orderId}) order by id for update`;
}
