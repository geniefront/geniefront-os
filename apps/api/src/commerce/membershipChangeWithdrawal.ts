import {withTenant} from '@gf/db';
import {AppError,ERROR_CODES} from '@gf/contracts';
import {dispatch} from '../bus';
import {commerceStripeClient} from './client';
import {commerceLiveMode} from './config';
import {reconcileMembership,verifiedSubscription} from './customerMembership';
import {withMembershipProviderLock} from './membershipLocks';
import type {Ctx} from './model';
import type {MembershipChange} from '../handlers/membershipChanges';
const idOf=(value:unknown):string|null=>typeof value==='string'?value:value&&typeof value==='object'&&'id' in value?String(value.id):null;
function invalid(reason:string):never{throw new AppError(ERROR_CODES.VALIDATION_FAILED,{details:{reason}});}
export async function withdrawMembershipChange(ctx:Ctx,changeId:string){
 const [row]=await withTenant(ctx,tx=>tx`select membership_id from customer_membership_plan_changes where id=${changeId}`);
 if(!row)throw new AppError(ERROR_CODES.NOT_FOUND);
 return withMembershipProviderLock(ctx,row.membership_id,async()=>{
  const [change]=await withTenant(ctx,tx=>tx<(MembershipChange&{created_at:Date})[]>`select * from customer_membership_plan_changes where id=${changeId}`);
  if(!change||!change.withdrawal_requested_at)invalid('membership_change_withdrawal_missing');
  if(['withdrawn','applied','canceled'].includes(change.status))return;
  const [m]=await withTenant(ctx,tx=>tx`select m.*,a.stripe_account_id,a.disconnected from customer_paid_memberships m join commerce_accounts a on a.id=m.account_id where m.id=${change.membership_id}`);
  if(!m||!m.stripe_subscription_id||m.disconnected||m.livemode!==commerceLiveMode())invalid('membership_change_unavailable');
  const stripe=commerceStripeClient(),options={stripeAccount:m.stripe_account_id};
  const verify=async()=>{const current=await verifiedSubscription(m.stripe_subscription_id,m.stripe_account_id,m.livemode);
   if(!current||current.m.id!==m.id||current.ctx.orgId!==ctx.orgId||current.ctx.locationId!==ctx.locationId)invalid('membership_change_provider_mismatch');return current;};
  let current=await verify();
  // At the boundary, the approved plan can win before our release. Never reverse a live price or invent a withdrawal.
  if(current.item.price.id!==change.previous_price_id){await reconcileMembership(ctx,m.original_order_id);return;}
  let scheduleId=change.stripe_schedule_id??idOf(current.sub.schedule),releasedScheduleId:string|null=null;
  if(scheduleId){
   let schedule=await stripe.subscriptionSchedules.retrieve(scheduleId,{},options);
   const expected={gf_domain:'customer_membership_change',gf_membership_id:m.id,gf_org_id:ctx.orgId,gf_location_id:ctx.locationId};
   const correctScope=Object.entries(expected).every(([k,v])=>schedule.metadata?.[k]===v);
   let owned=correctScope&&schedule.metadata?.gf_change_id===change.id;
   if(!owned&&change.stripe_schedule_id&&correctScope){
    const [prior]=await withTenant(ctx,tx=>tx`select id from customer_membership_plan_changes where membership_id=${m.id} and stripe_schedule_id=${scheduleId!} and id::text=${schedule.metadata?.gf_change_id??''} and status='applied' and effective_at<${change.effective_at}`);owned=!!prior;
   }
   if(!owned&&Object.keys(schedule.metadata??{}).length===0)for await(const event of stripe.events.list({type:'subscription_schedule.created',created:{gte:Math.floor(new Date(change.created_at).getTime()/1000)-60},limit:100},options)){
    if((event.data.object as {id:string}).id===scheduleId&&event.request?.idempotency_key===`gf-member-change:${change.id}:schedule`){owned=true;break;}
   }
   if(!owned&&change.stripe_schedule_id)invalid('membership_change_schedule_not_owned');
   // An unbound request may precede any provider work; leave another schedule untouched.
   if(owned){
    if(schedule.livemode!==m.livemode||idOf(schedule.customer)!==m.stripe_customer_id||idOf(schedule.subscription??schedule.released_subscription)!==m.stripe_subscription_id)invalid('membership_change_schedule_mismatch');
    if(['active','not_started'].includes(schedule.status)){
     await stripe.subscriptionSchedules.release(schedule.id,{preserve_cancel_date:true},{...options,idempotencyKey:`gf-member-change:${change.id}:withdraw`});
     schedule=await stripe.subscriptionSchedules.retrieve(schedule.id,{},options);
    }
    if(schedule.status!=='released'||idOf(schedule.released_subscription)!==m.stripe_subscription_id)invalid('membership_change_release_unconfirmed');
    releasedScheduleId=schedule.id;
   }
  }
  current=await verify();
  if(current.item.price.id!==change.previous_price_id){await reconcileMembership(ctx,m.original_order_id);return;}
  if(releasedScheduleId&&idOf(current.sub.schedule)===releasedScheduleId)invalid('membership_change_release_unconfirmed');
  await dispatch('commerce.completeMembershipChangeWithdrawal',{changeId,stripeAccountId:m.stripe_account_id,livemode:m.livemode,subscriptionId:m.stripe_subscription_id,
   previousPriceId:change.previous_price_id,releasedScheduleId},ctx,{systemOrigin:'commerce_verified_membership_change_withdrawal',idempotencyKey:`membership-withdrawal-verified:${changeId}`});
  await reconcileMembership(ctx,m.original_order_id);
 });
}
