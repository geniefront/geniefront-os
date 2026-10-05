import {canonicalCustomer,canonicalCustomerMap,customerFamilies} from '../customerIdentity';
import {AppError,ERROR_CODES,pickText,type CommandContext,type MembershipDiscountSelection} from '@gf/contracts';
import {allocateCheckoutPriceDiscounts,membershipLineDiscountCents} from '@gf/payroll';
import {jsonb} from '@gf/db';
import type {Tx} from '../commerce/model';
import type {PaidMembershipRow,MembershipSnapshot} from './customerMembership';
function invalid(reason:string):never{throw new AppError(ERROR_CODES.VALIDATION_FAILED,{details:{reason}});}
type PriceItem={id:string;total_cents:number;discount_cents:number;service_id:string|null;bundle_instance_id:string|null;kind:string};

/** Parent membership locks precede every cycle/package lock, including combined selections. */
export async function lockTicketMemberships(tx:Tx,cycleIds:readonly string[],discountMemberId?:string){
 const owners=await tx<{id:string}[]>`select id from customer_paid_memberships where id=${discountMemberId??null}::uuid
  or id in(select membership_id from customer_membership_cycles where id=any(${cycleIds}::uuid[])) order by id for update`;
 return owners.length;
}
/** Read-only server price offers do not require an unused service unit (pure-discount plans have zero). */
export async function loadMembershipDiscountOffers(tx:Tx,ctx:CommandContext,tickets:readonly {ticketId:string;customerId:string|null}[]){
 const customerIds=[...new Set(tickets.map(t=>t.customerId).filter((id):id is string=>!!id))];
 const result=new Map<string,Array<{membershipId:string;cycleId:string;planVersionId:string;name:string;discountBps:number;expiresAt:string;timezone:string;
   items:Array<{ticketItemId:string;expectedTotalCents:number;expectedDiscountCents:number}>}>>();
 if(!customerIds.length)return result;
 const roots=await canonicalCustomerMap(tx,customerIds);
 const members=await tx<(PaidMembershipRow&{cycle_id:string;ends_at:string;root_id:string;benefit_snapshot:MembershipSnapshot;invoice_plan_version_id:string})[]>`select m.*,f.root_id,c.id as cycle_id,c.ends_at::text,i.snapshot as benefit_snapshot,i.plan_version_id as invoice_plan_version_id
  from customer_paid_memberships m join customer_membership_cycles c on c.membership_id=m.id join customer_membership_invoices i on i.id=c.invoice_id join ${customerFamilies(tx,[...new Set(roots.values())])}f on f.id=m.customer_id
  where f.root_id=any(${[...new Set(roots.values())]}::uuid[]) and m.location_id=${ctx.locationId} and not m.commerce_frozen and m.terminated_at is null
   and c.status='issued' and c.starts_at<=now() and c.ends_at>now() and (i.snapshot->'terms'->>'discountBps')::int>0 order by c.ends_at,m.id`;
 const items=await tx<(PriceItem&{ticket_id:string})[]>`select id,ticket_id,total_cents,discount_cents,service_id,bundle_instance_id,kind
  from ticket_items where ticket_id=any(${tickets.map(t=>t.ticketId)}::uuid[]) order by seq,id`;
 for(const ticket of tickets){const offers=[];
  for(const m of members.filter(m=>m.root_id===roots.get(ticket.customerId??''))){
   const eligible=items.filter(i=>i.ticket_id===ticket.ticketId&&i.service_id&&['service','addon'].includes(i.kind)&&!i.bundle_instance_id
    &&i.discount_cents===0&&m.benefit_snapshot.terms.discountServiceIds.includes(i.service_id));
   const priced=eligible.map(i=>({ticketItemId:i.id,expectedTotalCents:i.total_cents,expectedDiscountCents:membershipLineDiscountCents(i.total_cents,m.benefit_snapshot.terms.discountBps)})).filter(i=>i.expectedDiscountCents>0);
   if(priced.length)offers.push({membershipId:m.id,cycleId:m.cycle_id,planVersionId:m.invoice_plan_version_id,name:pickText(m.benefit_snapshot.terms.name,ctx.locale),
    discountBps:m.benefit_snapshot.terms.discountBps,expiresAt:m.ends_at,timezone:m.benefit_snapshot.timezone,items:priced});
  }result.set(ticket.ticketId,offers);
 }return result;
}
/** Persist exact line price facts; discounted services use ordinary staff gross/net policy, never membership fee allocation. */
export async function applyTicketPriceDiscounts(tx:Tx,ctx:CommandContext,ticket:{id:string;customerId:string|null;businessDate:string},
 manualDiscountCents:number,selection:MembershipDiscountSelection|undefined,coveredItemIds:ReadonlySet<string>,persist=true){
 const items=await tx<PriceItem[]>`select id,total_cents,discount_cents,service_id,bundle_instance_id,kind from ticket_items where ticket_id=${ticket.id} order by seq,id`;
 const discounts=new Map<string,number>();let m:PaidMembershipRow|undefined,expiresAt:string|undefined,contract:MembershipSnapshot|undefined;
 if(selection){
  [m]=await tx<PaidMembershipRow[]>`select * from customer_paid_memberships where id=${selection.membershipId} for update`;
  if(!m||!ticket.customerId||await canonicalCustomer(tx,m.customer_id)!==await canonicalCustomer(tx,ticket.customerId)||m.commerce_frozen||m.terminated_at)invalid('membership_discount_unavailable');
  const [cycle]=await tx<{usable:boolean;ends_at:string;plan_version_id:string;snapshot:MembershipSnapshot}[]>`select c.status='issued' and c.starts_at<=now() and c.ends_at>now() as usable,c.ends_at::text,i.plan_version_id,i.snapshot from customer_membership_cycles c
   join customer_membership_invoices i on i.id=c.invoice_id where c.id=${selection.cycleId} and c.membership_id=${m.id} for update of c`;
  if(!cycle?.usable||cycle.plan_version_id!==selection.planVersionId||cycle.snapshot.terms.discountBps<=0)invalid('membership_discount_unavailable');
  expiresAt=cycle.ends_at;contract=cycle.snapshot;
  for(const choice of selection.items){const item=items.find(i=>i.id===choice.ticketItemId);
   if(!item||discounts.has(item.id)||coveredItemIds.has(item.id)||item.bundle_instance_id||item.discount_cents!==0||!item.service_id
    ||!['service','addon'].includes(item.kind)||!contract!.terms.discountServiceIds.includes(item.service_id))invalid('membership_discount_service_unavailable');
   const discount=membershipLineDiscountCents(item.total_cents,contract!.terms.discountBps);
   if(item.total_cents!==choice.expectedTotalCents||discount!==choice.expectedDiscountCents||discount<=0)invalid('membership_discount_quote_changed');
   discounts.set(item.id,discount);
  }
 }
 let adjustments;
 try{adjustments=allocateCheckoutPriceDiscounts({items:items.map(i=>({id:i.id,totalCents:i.total_cents})),coveredItemIds,membershipDiscounts:discounts,manualDiscountCents});}
 catch{invalid('price_discount_exceeds_uncovered_services');}
 for(const a of adjustments){const member=a.kind==='membership';
  if(persist)await tx`insert into ticket_price_adjustments(org_id,location_id,ticket_id,ticket_item_id,kind,original_cents,discount_cents,
   customer_membership_id,cycle_id,plan_version_id,business_date,actor_membership_id,rule_snapshot)
   values(${ctx.orgId},${ctx.locationId},${ticket.id},${a.ticketItemId},${a.kind},${a.originalCents},${a.discountCents},
    ${member?m!.id:null},${member?selection!.cycleId:null},${member?selection!.planVersionId:null},${ticket.businessDate},${ctx.membershipId},
    ${jsonb(member?{discountBps:contract!.terms.discountBps,rounding:'half_up_per_line',commissionPolicy:'staff_gross_or_net',expiresAt}:{allocation:'uncovered_unpriced_lines',manualAuthorized:true})}::jsonb)`;
 }
 return {discountCents:adjustments.reduce((sum,a)=>sum+a.discountCents,0),discountByItem:new Map(adjustments.map(a=>[a.ticketItemId,a.discountCents]))};
}
