import type {CommandContext} from '@gf/contracts';
import {normalizeCardCode} from '@gf/payroll';
import type {Tx} from '../commerce/model';
import {canonicalCustomer} from '../customerIdentity';
import {lockBookingCapacity} from './appointment';

/** Transaction-local allocation budgets. They never replace persisted ledger balances. */
export type CheckoutPlanningBalances={
 membershipUnits:Map<string,string>;
 packages:Map<string,{available_units:string;remaining_sessions:number}>;
 deposits:Map<string,number>;
 depositPayments:Map<string,number>;
 depositPaymentGuests:Map<string,Map<number,number>>;
 depositGuests:Map<string,Map<number,number>>;
 gifts:Map<string,number>;
 credits:Map<string,number>;
};
export function checkoutPlanningBalances():CheckoutPlanningBalances{return {
 membershipUnits:new Map(),packages:new Map(),deposits:new Map(),depositPayments:new Map(),depositPaymentGuests:new Map(),depositGuests:new Map(),gifts:new Map(),credits:new Map(),
};}
type Selection={customerId?:string|null;packageRedemptions?:readonly {customerPackageId:string}[]|undefined;
 membershipRedemptions?:readonly {cycleId:string}[]|undefined;membershipDiscount?:{membershipId:string;cycleId:string}|undefined;
 depositApplication?:{holdId:string}|undefined;payments?:readonly {method:string;giftCardId?:string|undefined;giftCardCode?:string|undefined}[]|undefined};
/** Every single/group checkout locks each asset class in the same order before planning. */
export async function lockCheckoutAssets(tx:Tx,ctx:CommandContext,selections:readonly Selection[]){
 const cycles=[...new Set(selections.flatMap(s=>[...(s.membershipRedemptions??[]).map(r=>r.cycleId),...(s.membershipDiscount?[s.membershipDiscount.cycleId]:[])]))];
 const members=selections.flatMap(s=>s.membershipDiscount?[s.membershipDiscount.membershipId]:[]);
 if(cycles.length||members.length){
  await tx`select id from customer_paid_memberships where id=any(${members}::uuid[]) or id in(select membership_id from customer_membership_cycles where id=any(${cycles}::uuid[])) order by id for update`;
  await tx`select id from customer_membership_cycles where id=any(${cycles}::uuid[]) order by id for update`;
 }
 const packages=[...new Set(selections.flatMap(s=>(s.packageRedemptions??[]).map(p=>p.customerPackageId)))];
 if(packages.length)await tx`select id from customer_packages where id=any(${packages}::uuid[]) order by id for update`;
 const deposits=[...new Set(selections.flatMap(s=>s.depositApplication?[s.depositApplication.holdId]:[]))];
 if(deposits.length){await lockBookingCapacity(tx,ctx.locationId);await tx`select id from commerce_appointment_holds where id=any(${deposits}::uuid[]) order by id for update`;}
 const gifts=selections.flatMap(s=>(s.payments??[]).filter(p=>p.method==='gift_card'));
 if(gifts.length){const ids=gifts.flatMap(p=>p.giftCardId?[p.giftCardId]:[]),codes=gifts.flatMap(p=>p.giftCardCode?[normalizeCardCode(p.giftCardCode)]:[]);
  await tx`select id from gift_cards where id=any(${ids}::uuid[]) or replace(code,'-','')=any(${codes}::text[]) order by id for update`;
 }
 const creditCustomers=[...new Set(selections.filter(s=>s.payments?.some(p=>p.method==='customer_credit')).flatMap(s=>s.customerId?[s.customerId]:[]))];
 const roots:string[]=[];for(const id of creditCustomers)roots.push(await canonicalCustomer(tx,id));
 if(roots.length)await tx`select id from customers where id=any(${[...new Set([...roots,...creditCustomers])]}::uuid[]) order by id for update`;
}
