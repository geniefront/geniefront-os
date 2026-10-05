import {AppError,ERROR_CODES,CommerceRequestMembershipChange,CommerceBindMembershipChange,CommerceWithdrawMembershipChange,CommerceCompleteMembershipChangeWithdrawal,type CustomerMembershipTerms} from '@gf/contracts';
import {jsonb} from '@gf/db';
import {registerHandler} from '../bus';
import {queueTask} from './commerce';
import type {PaidMembershipRow,MembershipSnapshot} from './customerMembership';
function invalid(reason:string):never{throw new AppError(ERROR_CODES.VALIDATION_FAILED,{details:{reason}});}
export type MembershipChange={id:string;membership_id:string;plan_version_id:string;snapshot:MembershipSnapshot;effective_at:Date;previous_price_id:string;stripe_price_id:string|null;stripe_schedule_id:string|null;status:string;withdrawal_requested_at:Date|null};
registerHandler(CommerceRequestMembershipChange,async({tx,ctx,input,audit})=>{
 const [m]=await tx<(PaidMembershipRow&{current_price_id:string|null;current_period_end:Date|null})[]>`select * from customer_paid_memberships where id=${input.membershipId}
  and manage_token_hash=${input.tokenHash} and manage_token_revoked_at is null and manage_token_expires_at>now() for update`;
 if(!m)throw new AppError(ERROR_CODES.NOT_FOUND);
 const [location]=await tx<{enabled:boolean}[]>`select coalesce((settings->'commerce'->>'membershipsEnabled')::boolean,false) as enabled from locations where id=${ctx.locationId}`;
 if(!location?.enabled)invalid('new_memberships_disabled');
 const [account]=await tx<{disconnected:boolean;charges_enabled:boolean}[]>`select disconnected,charges_enabled from commerce_accounts where id=${m.account_id}`;
 if(m.provider_status!=='active'||m.commerce_frozen||m.terminated_at||m.cancel_at_period_end||m.scheduled_cancel_at||!m.stripe_subscription_id||!m.stripe_price_id||!m.current_period_end||account?.disconnected||!account?.charges_enabled)invalid('membership_change_unavailable');
 if(new Date(m.current_period_end!).toISOString()!==input.expectedPeriodEnd||input.consent.effectiveAt!==input.expectedPeriodEnd||input.consent.versionId!==input.versionId)invalid('membership_change_quote_changed');
 const [p]=await tx<{id:string;terms:CustomerMembershipTerms;currency:string}[]>`select v.id,v.terms,v.currency from customer_membership_plan_versions v join customer_membership_plans p on p.id=v.plan_id
  where v.id=${input.versionId} and p.active and p.online_sale and v.id=(select id from customer_membership_plan_versions where plan_id=p.id order by version desc limit 1)`;
 if(!p||p.currency!==m.snapshot.currency||p.terms.amountCents!==input.consent.amountCents||p.terms.cadence!==input.consent.cadence)invalid('membership_change_quote_changed');
 const [paid]=await tx`select id from customer_membership_invoices where membership_id=${m.id} limit 1`;if(!paid)invalid('membership_change_requires_paid_period');
 const [pending]=await tx`select id from customer_membership_plan_changes where membership_id=${m.id} and status in('pending','scheduled')`;if(pending)invalid('membership_change_already_pending');
 const snapshot={...m.snapshot,terms:p!.terms,currency:p!.currency},consent={...input.consent,acceptedAt:new Date().toISOString()};
 const [change]=await tx<{id:string}[]>`insert into customer_membership_plan_changes(org_id,location_id,membership_id,plan_version_id,snapshot,consent,effective_at,previous_price_id)
  values(${ctx.orgId},${ctx.locationId},${m.id},${p!.id},${jsonb(snapshot)}::jsonb,${jsonb(consent)}::jsonb,${input.expectedPeriodEnd}::timestamptz,${m.current_price_id??m.stripe_price_id}) returning id`;
 await queueTask(tx,ctx,'membership_change',change!.id);audit({entityType:'customer_membership_plan_change',entityId:change!.id,after:{membershipId:m.id,versionId:p!.id,effectiveAt:input.expectedPeriodEnd,customerConsent:true,status:'pending'}});
 return {changeId:change!.id,status:'pending'};
});
registerHandler(CommerceBindMembershipChange,async({tx,input,audit})=>{
 const [link]=await tx<{membership_id:string}[]>`select membership_id from customer_membership_plan_changes where id=${input.changeId}`;if(!link)throw new AppError(ERROR_CODES.NOT_FOUND);
 const [m]=await tx<(PaidMembershipRow&{stripe_account_id:string})[]>`select m.*,a.stripe_account_id from customer_paid_memberships m join commerce_accounts a on a.id=m.account_id where m.id=${link.membership_id} for update of m`;
 const [change]=await tx<MembershipChange[]>`select * from customer_membership_plan_changes where id=${input.changeId} for update`;
 if(!m||!change||m.stripe_account_id!==input.stripeAccountId||m.livemode!==input.livemode||m.stripe_subscription_id!==input.subscriptionId||new Date(change.effective_at).toISOString()!==input.effectiveAt
  ||change.stripe_price_id&&change.stripe_price_id!==input.stripePriceId||change.stripe_schedule_id&&change.stripe_schedule_id!==input.stripeScheduleId)invalid('membership_change_provider_mismatch');
 await tx`update customer_membership_plan_changes set stripe_price_id=${input.stripePriceId},stripe_schedule_id=${input.stripeScheduleId},
  status=case when status in('applied','withdrawn','canceled') then status when ${input.scheduled} then 'scheduled' else status end,
  scheduled_at=case when ${input.scheduled} then coalesce(scheduled_at,now()) else scheduled_at end,updated_at=now() where id=${input.changeId}`;
 audit({entityType:'customer_membership_plan_change',entityId:input.changeId,after:{providerBound:true,scheduled:input.scheduled}});return {recorded:true};
});

registerHandler(CommerceWithdrawMembershipChange,async({tx,ctx,input,audit})=>{
 const [m]=await tx`select id from customer_paid_memberships where id=${input.membershipId} and manage_token_hash=${input.tokenHash}
  and manage_token_revoked_at is null and manage_token_expires_at>now() for update`;
 if(!m)throw new AppError(ERROR_CODES.NOT_FOUND);
 const [change]=await tx<MembershipChange[]>`select * from customer_membership_plan_changes where id=${input.changeId} and membership_id=${m.id} for update`;
 if(!change)throw new AppError(ERROR_CODES.NOT_FOUND);
 if(['applied','canceled'].includes(change.status))invalid('membership_change_already_applied');
 if(change.status!=='withdrawn'){
  await tx`update customer_membership_plan_changes set withdrawal_requested_at=coalesce(withdrawal_requested_at,now()),updated_at=now() where id=${change.id}`;
  await queueTask(tx,ctx,'membership_change_withdraw',change.id);
 }
 audit({entityType:'customer_membership_plan_change',entityId:change.id,after:{withdrawalRequested:true}});
 return {changeId:change.id,status:change.status==='withdrawn'?'withdrawn':'withdrawing'};
});
registerHandler(CommerceCompleteMembershipChangeWithdrawal,async({tx,input,audit})=>{
 const [link]=await tx`select membership_id from customer_membership_plan_changes where id=${input.changeId}`;if(!link)throw new AppError(ERROR_CODES.NOT_FOUND);
 const [m]=await tx`select m.*,a.stripe_account_id from customer_paid_memberships m join commerce_accounts a on a.id=m.account_id where m.id=${link.membership_id} for update of m`;
 const [change]=await tx<MembershipChange[]>`select * from customer_membership_plan_changes where id=${input.changeId} for update`;
 if(!m||!change||m.stripe_account_id!==input.stripeAccountId||m.livemode!==input.livemode||m.stripe_subscription_id!==input.subscriptionId
  ||change.previous_price_id!==input.previousPriceId||change.stripe_schedule_id&&change.stripe_schedule_id!==input.releasedScheduleId
  ||!change.withdrawal_requested_at)invalid('membership_change_withdrawal_mismatch');
 if(['applied','canceled'].includes(change.status))return {recorded:false};
 if((m.current_price_id??m.stripe_price_id)!==input.previousPriceId)invalid('membership_change_withdrawal_price_changed');
 await tx`update customer_membership_plan_changes set status='withdrawn',withdrawn_at=coalesce(withdrawn_at,now()),updated_at=now() where id=${change.id}`;
 audit({entityType:'customer_membership_plan_change',entityId:change.id,after:{withdrawn:true,providerVerified:true}});return {recorded:true};
});
