import {canonicalCustomer} from '../customerIdentity';
import {AppError,ERROR_CODES,membershipText,pickText,type CommandContext} from '@gf/contracts';
import {escapeHtml} from '../email/layout';
import {jsonb} from '@gf/db';
import {parsePackageUnitRanges,formatPackageUnitRanges,packageRangeCount,packageRangeValue,takePackageUnits,largestRemainderSplit} from '@gf/payroll';
import {businessDateOf} from '@gf/scheduling';
import type {Tx} from '../commerce/model';
import type {CheckoutPlanningBalances} from './checkoutPlanning';
import type {PaidMembershipRow,MembershipSnapshot} from './customerMembership';
function invalid(reason:string):never{throw new AppError(ERROR_CODES.VALIDATION_FAILED,{details:{reason}});}
export type MembershipRedemption={cycleId:string;ticketItemIds:readonly string[]};
type Cycle={id:string;membership_id:string;quantity:number;value_cents:number;available_units:string;status:string;due:boolean;expired:boolean;snapshot:MembershipSnapshot};
async function currentBusinessDate(tx:Tx,ctx:CommandContext){
 const [location]=await tx<{timezone:string;cutoff:string}[]>`select timezone,business_day_cutoff::text as cutoff from locations where id=${ctx.locationId}`;
 if(!location)throw new AppError(ERROR_CODES.NOT_FOUND);return businessDateOf(new Date(),location.timezone,location.cutoff);
}
/** Every selected execution item owns exactly one immutable funded membership unit. */
export async function applyMembershipRedemptions(tx:Tx,ctx:CommandContext,ticket:{id:string;customerId:string|null;businessDate:string},selections:readonly MembershipRedemption[],persist=true,balances?:CheckoutPlanningBalances){
 const itemIds=selections.flatMap(s=>[...s.ticketItemIds]),cycleIds=selections.map(s=>s.cycleId);
 const commissionDiscountByItem=new Map<string,number>(),commissionBaseByItem=new Map<string,number>(),usedItemIds=new Set<string>();let coveredCents=0;
 if(!selections.length)return {coveredCents,commissionDiscountByItem,commissionBaseByItem,usedItemIds};
 if(!ticket.customerId)invalid('membership_requires_ticket_customer');
 if(new Set(itemIds).size!==itemIds.length||new Set(cycleIds).size!==cycleIds.length)invalid('duplicate_membership_redemption');
 const owners=await tx<{membership_id:string}[]>`select distinct membership_id from customer_membership_cycles where id=any(${cycleIds}::uuid[]) order by membership_id`;
 const members=new Map<string,PaidMembershipRow>();
 for(const owner of owners){
  const [m]=await tx<PaidMembershipRow[]>`select * from customer_paid_memberships where id=${owner.membership_id} for update`;
  if(!m||!ticket.customerId||await canonicalCustomer(tx,m.customer_id)!==await canonicalCustomer(tx,ticket.customerId)||m.commerce_frozen||m.terminated_at)invalid('membership_unavailable');members.set(m.id,m);
 }
 const items=await tx<{id:string;service_id:string|null;bundle_instance_id:string|null;total_cents:number}[]>`
  select id,service_id,bundle_instance_id,total_cents from ticket_items where ticket_id=${ticket.id} and id=any(${itemIds}::uuid[]) order by seq,id`;
 for(const selection of [...selections].sort((a,b)=>a.cycleId.localeCompare(b.cycleId))){
  const [cycle]=await tx<Cycle[]>`select c.*,i.snapshot,c.starts_at<=now() as due,c.ends_at<=now() as expired from customer_membership_cycles c
   join customer_membership_invoices i on i.id=c.invoice_id where c.id=${selection.cycleId} for update of c`;
  const member=cycle&&members.get(cycle.membership_id);
  if(!cycle||!member||cycle.status!=='issued'||!cycle.due||cycle.expired)invalid('membership_cycle_unavailable');
  let available=parsePackageUnitRanges(balances?.membershipUnits.get(cycle.id)??cycle.available_units,cycle.quantity);
  const selectedItems=items.filter(i=>selection.ticketItemIds.includes(i.id));
  if(selectedItems.length!==selection.ticketItemIds.length)invalid('membership_service_unavailable');
  for(const item of selectedItems){
   if(!item||!item.service_id||item.bundle_instance_id||item.total_cents<=0||!cycle.snapshot.terms.serviceIds.includes(item.service_id))invalid('membership_service_unavailable');
   if(packageRangeCount(available)<1)invalid('membership_insufficient_services');
   const allocation=takePackageUnits(cycle.value_cents,cycle.quantity,available,1),basis=cycle.snapshot.terms.commissionBasis;
   const commissionBase=basis==='catalog_price'?item.total_cents:basis==='zero'?0:allocation.valueCents;
   if(persist)await tx`insert into customer_membership_ledger(org_id,location_id,cycle_id,entry,quantity,value_cents,unit_ranges,ticket_id,ticket_item_id,reference,covered_cents,business_date,meta)
    values(${ctx.orgId},${ctx.locationId},${cycle.id},'redeem',-1,${-allocation.valueCents},${formatPackageUnitRanges(allocation.taken)}::int4multirange,
     ${ticket.id},${item.id},${`redeem:${item.id}`},${item.total_cents},${ticket.businessDate},${jsonb({commissionBasis:basis,commissionBaseCents:commissionBase})}::jsonb)`;
   available=allocation.remaining;
   balances?.membershipUnits.set(cycle.id,formatPackageUnitRanges(available));
   if(persist)await tx`update customer_membership_cycles set available_units=${formatPackageUnitRanges(available)}::int4multirange where id=${cycle.id}`;
   coveredCents+=item.total_cents;usedItemIds.add(item.id);commissionDiscountByItem.set(item.id,Math.max(0,item.total_cents-commissionBase));commissionBaseByItem.set(item.id,commissionBase);
  }
 }
 return {coveredCents,commissionDiscountByItem,commissionBaseByItem,usedItemIds};
}
/** The ticket lock is already held. Partial monetary coverage returns never create fractional sessions. */
export async function restoreTicketMemberships(tx:Tx,ctx:CommandContext,ticketId:string,refundId:string,amount:number,date:string,allocations?:Array<{redemptionId:string;amountCents:number}>){
 if(amount<=0)return;
 const owners=await tx<{membership_id:string}[]>`select distinct c.membership_id from customer_membership_ledger l join customer_membership_cycles c on c.id=l.cycle_id
  where l.ticket_id=${ticketId} and l.entry='redeem' order by c.membership_id`;
 for(const owner of owners)await tx`select id from customer_paid_memberships where id=${owner.membership_id} for update`;
 const originals=await tx<{id:string;cycle_id:string;ticket_item_id:string;covered_cents:number;value_cents:number;unit_ranges:string;remaining:number}[]>`
  select l.*,l.covered_cents-coalesce((select sum(r.covered_cents) from customer_membership_service_refunds r where r.redemption_id=l.id),0)::int as remaining
  from customer_membership_ledger l where l.ticket_id=${ticketId} and l.entry='redeem' order by l.cycle_id,l.id`;
 if(originals.reduce((sum,r)=>sum+r.remaining,0)<amount)invalid('membership_refund_exceeds_original_coverage');
 if(allocations&&(allocations.reduce((s,r)=>s+r.amountCents,0)!==amount||new Set(allocations.map(r=>r.redemptionId)).size!==allocations.length||allocations.some(r=>!originals.some(o=>o.id===r.redemptionId&&r.amountCents>0&&r.amountCents<=o.remaining))))invalid('membership_refund_source_mismatch');
 const shares=allocations?originals.map(o=>allocations.find(r=>r.redemptionId===o.id)?.amountCents??0):largestRemainderSplit(amount,originals.map(r=>r.remaining),{zeroWeights:'throw'});
 for(const [index,original] of originals.entries()){
  const returned=shares[index]!;if(returned<=0)continue;
  const [cycle]=await tx<{id:string;expired:boolean;terminated:boolean}[]>`select c.id,c.ends_at<=now() as expired,m.terminated_at is not null or c.status='stopped' as terminated
   from customer_membership_cycles c join customer_paid_memberships m on m.id=c.membership_id where c.id=${original.cycle_id} for update of c`;
  if(!cycle)invalid('membership_restore_source_missing');
  await tx`insert into customer_membership_service_refunds(org_id,location_id,redemption_id,ticket_refund_id,covered_cents)
   values(${ctx.orgId},${ctx.locationId},${original.id},${refundId},${returned})`;
  if(returned!==original.remaining)continue;
  await tx`insert into customer_membership_ledger(org_id,location_id,cycle_id,entry,quantity,value_cents,unit_ranges,ticket_id,ticket_item_id,redemption_id,ticket_refund_id,reference,covered_cents,business_date)
   values(${ctx.orgId},${ctx.locationId},${cycle.id},'restore',1,${-original.value_cents},${original.unit_ranges}::int4multirange,
    ${ticketId},${original.ticket_item_id},${original.id},${refundId},${`restore:${original.id}`},${original.covered_cents},${date})`;
  await tx`update customer_membership_cycles set available_units=available_units+${original.unit_ranges}::int4multirange where id=${cycle.id}`;
  if(cycle.expired||cycle.terminated){
   await tx`insert into customer_membership_ledger(org_id,location_id,cycle_id,entry,quantity,value_cents,unit_ranges,ticket_id,ticket_item_id,redemption_id,ticket_refund_id,reference,business_date,meta)
    values(${ctx.orgId},${ctx.locationId},${cycle.id},'expire',-1,${original.value_cents},${original.unit_ranges}::int4multirange,
     ${ticketId},${original.ticket_item_id},${original.id},${refundId},${`expire:restore:${original.id}`},${date},${jsonb({restoredAfterExpiry:true})}::jsonb)`;
   await tx`update customer_membership_cycles set available_units=available_units-${original.unit_ranges}::int4multirange where id=${cycle.id}`;
  }
 }
}
/** Expiry is append-only and uses actual database time, including missed-run compensation. */
export async function expireMembershipCycles(tx:Tx,ctx:CommandContext,m:PaidMembershipRow){
 const ended=await tx<{id:string;quantity:number;value_cents:number;available_units:string;status:string;snapshot:MembershipSnapshot}[]>`
  select c.id,c.quantity,c.value_cents,c.available_units,c.status,i.snapshot from customer_membership_cycles c join customer_membership_invoices i on i.id=c.invoice_id
  where c.membership_id=${m.id} and c.status in('planned','issued') and (c.ends_at<=now() or ${!!m.terminated_at}) order by c.starts_at,c.id for update of c`;
 if(!ended.length)return 0;const date=await currentBusinessDate(tx,ctx);
 for(const c of ended){
  const units=parsePackageUnitRanges(c.available_units,c.quantity),quantity=packageRangeCount(units),value=packageRangeValue(c.value_cents,c.quantity,units);
  await tx`insert into customer_membership_ledger(org_id,location_id,cycle_id,entry,quantity,value_cents,unit_ranges,reference,business_date,meta)
   values(${ctx.orgId},${ctx.locationId},${c.id},'expire',${-quantity},${-value},${c.available_units}::int4multirange,
    ${`expire:${c.id}`},${date},${jsonb({neverIssued:c.status==='planned',terminated:!!m.terminated_at})}::jsonb)`;
  await tx`update customer_membership_cycles set available_units='{}'::int4multirange,status='expired' where id=${c.id}`;
  if((quantity>0||c.status==='planned')&&!m.terminated_at){
   const [customer]=await tx<{email:string|null;locale:string|null}[]>`select email,locale from customers where id=${m.customer_id}`;
   if(customer?.email){const locale=customer.locale??'en',body=`${pickText(c.snapshot.terms.name,locale)}\n${membershipText(locale,'expiryNotice')}`;
    await tx`insert into email_outbox(org_id,location_id,kind,to_email,subject,body_html,body_text,entity_type,entity_id,commerce_order_id)
     values(${ctx.orgId},${ctx.locationId},'platform_notice',${customer.email},${membershipText(locale,'title')},${`<p>${escapeHtml(body)}</p>`},${body},
      'customer_membership_expiry',${c.id},${m.original_order_id}) on conflict(entity_type,entity_id,kind) do nothing`;
   }
  }
 }
 return ended.length;
}
