import type Stripe from 'stripe';
import {withTenant} from '@gf/db';
import {AppError,ERROR_CODES} from '@gf/contracts';
import {dispatch} from '../bus';
import {commerceStripeClient} from './client';
import {commerceLiveMode} from './config';
import type {Ctx} from './model';
import type {MembershipChange} from '../handlers/membershipChanges';
import type {PaidMembershipRow} from '../handlers/customerMembership';
import {withMembershipProviderLock} from './membershipLocks';
import {reconcileMembership} from './customerMembership';
const idOf=(value:unknown):string|null=>typeof value==='string'?value:value&&typeof value==='object'&&'id' in value?String(value.id):null;
function invalid(reason:string):never{throw new AppError(ERROR_CODES.VALIDATION_FAILED,{details:{reason}});}
/** No new subscription. Recover provider objects using immutable business identity, then verify both phases. */
export async function scheduleMembershipChange(ctx:Ctx,changeId:string){
 const [row]=await withTenant(ctx,tx=>tx`select membership_id from customer_membership_plan_changes where id=${changeId}`);
 if(!row)throw new AppError(ERROR_CODES.NOT_FOUND);
 return withMembershipProviderLock(ctx,row.membership_id,()=>scheduleMembershipChangeLocked(ctx,changeId));
}
async function scheduleMembershipChangeLocked(ctx:Ctx,changeId:string){
 const [change]=await withTenant(ctx,tx=>tx<(MembershipChange&{created_at:Date})[]>`select * from customer_membership_plan_changes where id=${changeId}`);
 if(!change)throw new AppError(ERROR_CODES.NOT_FOUND);if(['applied','withdrawn','canceled'].includes(change.status)||change.withdrawal_requested_at)return;
 const [m]=await withTenant(ctx,tx=>tx<(PaidMembershipRow&{stripe_account_id:string;disconnected:boolean})[]>`select m.*,a.stripe_account_id,a.disconnected from customer_paid_memberships m join commerce_accounts a on a.id=m.account_id where m.id=${change.membership_id}`);
 if(!m||!m.stripe_subscription_id||!m.stripe_customer_id||m.disconnected||m.commerce_frozen||m.terminated_at||m.livemode!==commerceLiveMode())invalid('membership_change_unavailable');
 const stripe=commerceStripeClient(),options={stripeAccount:m.stripe_account_id},effective=Math.floor(new Date(change.effective_at).getTime()/1000),terms=change.snapshot.terms;
 const sub=await stripe.subscriptions.retrieve(m.stripe_subscription_id,{},options),item=sub.items.data[0];
 if(sub.livemode!==m.livemode||idOf(sub.customer)!==m.stripe_customer_id||sub.metadata.gf_domain!=='customer_commerce'||sub.metadata.gf_membership_id!==m.id
  ||sub.metadata.gf_org_id!==ctx.orgId||sub.metadata.gf_location_id!==ctx.locationId||sub.status!=='active'||sub.cancel_at||sub.cancel_at_period_end||sub.items.has_more||sub.items.data.length!==1||item?.quantity!==1
  ||sub.trial_end||sub.discounts.length||item.discounts.length||sub.automatic_tax?.enabled||sub.default_tax_rates?.length)invalid('membership_change_subscription_mismatch');
 const key=`gf-member-change:${change.id}`,metadata={gf_domain:'customer_membership_change',gf_membership_id:m.id,gf_change_id:change.id,gf_org_id:ctx.orgId,gf_location_id:ctx.locationId};
 const prices=await stripe.prices.list({lookup_keys:[key],limit:2},options);if(prices.has_more||prices.data.length>1)invalid('membership_change_price_ambiguous');
 const price=prices.data[0]??await stripe.prices.create({lookup_key:key,currency:change.snapshot.currency,unit_amount:terms.amountCents,recurring:{interval:terms.cadence,interval_count:1},metadata,product_data:{name:terms.name.en!}},{...options,idempotencyKey:`${key}:price`});
 if(price.livemode!==m.livemode||price.lookup_key!==key||price.unit_amount!==terms.amountCents||price.currency!==change.snapshot.currency||price.recurring?.interval!==terms.cadence||price.recurring.interval_count!==1
  ||Object.entries(metadata).some(([k,v])=>price.metadata[k]!==v))invalid('membership_change_price_mismatch');
 let schedule:Stripe.SubscriptionSchedule;
 const linked=change.stripe_schedule_id??idOf(sub.schedule);
 if(linked){
  schedule=await stripe.subscriptionSchedules.retrieve(linked,{},options);
  if(schedule.metadata?.gf_change_id!==change.id){
   // Recover the crash gap after from_subscription succeeded but before its database binding.
   const [prior]=await withTenant(ctx,tx=>tx`select id from customer_membership_plan_changes where membership_id=${m.id} and stripe_schedule_id=${linked} and status='applied' and effective_at<${change.effective_at} and id::text=${schedule.metadata?.gf_change_id??''} limit 1`);
   let owned=!!prior&&Object.entries(metadata).filter(([k])=>k!=='gf_change_id').every(([k,v])=>schedule.metadata?.[k]===v);
   if(!owned&&Object.keys(schedule.metadata??{}).length===0)for await(const event of stripe.events.list({type:'subscription_schedule.created',created:{gte:Math.floor(new Date(change.created_at).getTime()/1000)-60},limit:100},options)){
    if((event.data.object as {id:string}).id===linked&&event.request?.idempotency_key===`${key}:schedule`){owned=true;break;}
   }if(!owned)invalid('membership_change_schedule_not_owned');
  }else if(Object.entries(metadata).some(([k,v])=>schedule.metadata?.[k]!==v))invalid('membership_change_schedule_not_owned');
 }else schedule=await stripe.subscriptionSchedules.create({from_subscription:sub.id},{...options,idempotencyKey:`${key}:schedule`});
 if(schedule.livemode!==m.livemode||idOf(schedule.customer)!==m.stripe_customer_id||idOf(schedule.subscription)!==sub.id||!['active','not_started'].includes(schedule.status))invalid('membership_change_schedule_mismatch');
 const bind=async(scheduled:boolean)=>dispatch('commerce.bindMembershipChange',{changeId:change.id,stripeAccountId:m.stripe_account_id,livemode:m.livemode,subscriptionId:sub.id,
  stripePriceId:price.id,stripeScheduleId:schedule.id,effectiveAt:new Date(effective*1000).toISOString(),scheduled},ctx,
  {systemOrigin:'commerce_verified_membership_change',idempotencyKey:`${key}:bind:${scheduled}`});
 await bind(false);
 const matches=(value:Stripe.SubscriptionSchedule)=>{
  const [old,next]=value.phases;
  return value.phases.length===2&&value.end_behavior==='release'&&value.metadata?.gf_change_id===change.id
   &&old?.end_date===effective&&old.items.length===1&&idOf(old.items[0]?.price)===change.previous_price_id&&old.items[0]?.quantity===1&&old.proration_behavior==='none'
   &&next?.start_date===effective&&next.items.length===1&&idOf(next.items[0]?.price)===price.id&&next.items[0]?.quantity===1&&next.proration_behavior==='none'
   &&next.billing_cycle_anchor==='phase_start'&&next.add_invoice_items.length===0&&!next.discounts?.length&&!next.default_tax_rates?.length&&!next.items[0]?.discounts?.length;
 };
 if(!matches(schedule)){
  // Once confirmed, external edits require review instead of silently overwriting them on a retry.
  if(change.status==='scheduled')invalid('membership_change_schedule_modified');
  if(item.price.id!==change.previous_price_id||item.current_period_end!==effective)invalid('membership_change_period_changed');
  schedule=await stripe.subscriptionSchedules.update(schedule.id,{end_behavior:'release',proration_behavior:'none',metadata,
   phases:[{start_date:item.current_period_start,end_date:effective,items:[{price:change.previous_price_id,quantity:1}],proration_behavior:'none'},
    {start_date:effective,duration:{interval:terms.cadence,interval_count:1},items:[{price:price.id,quantity:1}],proration_behavior:'none',billing_cycle_anchor:'phase_start',metadata:{gf_plan_change_id:change.id,gf_plan_version_id:change.plan_version_id}}]},
   {...options,idempotencyKey:`${key}:phases`});
 }
 schedule=await stripe.subscriptionSchedules.retrieve(schedule.id,{},options);if(!matches(schedule))invalid('membership_change_phases_not_confirmed');
 await bind(true);
 await reconcileMembership(ctx,m.original_order_id);
}
