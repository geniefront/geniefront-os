import {AppError,ERROR_CODES} from '@gf/contracts';
import type {Tx} from './model';
import type {MembershipSnapshot,PaidMembershipRow} from '../handlers/customerMembership';
/** Resolve the approved contract for this billing interval, including historical invoices after a price transition. */
export async function membershipInvoiceContract(tx:Tx,m:PaidMembershipRow,priceId:string,startsAt:string){
 const [change]=await tx<{id:string;plan_version_id:string;snapshot:MembershipSnapshot;stripe_price_id:string}[]>`
  select id,plan_version_id,snapshot,stripe_price_id from customer_membership_plan_changes where membership_id=${m.id}
   and status in('scheduled','applied') and effective_at<=${startsAt}::timestamptz order by effective_at desc limit 1`;
 const expected=change?.stripe_price_id??m.stripe_price_id;
 if(expected&&expected!==priceId)throw new AppError(ERROR_CODES.VALIDATION_FAILED,{details:{reason:'membership_unapproved_price'}});
 return {snapshot:change?.snapshot??m.snapshot,versionId:change?.plan_version_id??m.plan_version_id,changeId:change?.id??null};
}
export async function membershipCurrentContract(tx:Tx,m:PaidMembershipRow,priceId:string,startsAt?:string){
 if(startsAt)return membershipInvoiceContract(tx,m,priceId,startsAt);
 if(m.stripe_price_id&&priceId!==m.stripe_price_id)throw new AppError(ERROR_CODES.VALIDATION_FAILED,{details:{reason:'membership_price_period_required'}});
 return {snapshot:m.snapshot,versionId:m.plan_version_id,changeId:null};
}
