import {useQuery} from '@tanstack/react-query';
import {apiGet} from '@/lib/api';
import {useSession} from '@/lib/session';
export interface CommerceData {
  enabled:boolean;settings:{salesEnabled:boolean;depositsEnabled:boolean;membershipsEnabled:boolean};
  accounts:Array<{id:string;stripe_account_id:string;livemode:boolean;charges_enabled:boolean;disconnected:boolean}>;
  orders:Array<{id:string;kind:string;channel:string;status:string;name:string;amount_cents:number;currency:string;customer_name:string|null;
    unlimited_package?:boolean;payment_id:string|null;payment_status:string|null;refunded_cents:number;created_at:string;checkout_url:string|null;
    paid_at:string|null;settlement_currency:string|null;settlement_gross_cents:number|null;fee_cents:number|null;net_cents:number|null;refund_requires_review:boolean}>;
  refunds:Array<{id:string;payment_id:string;status:string;provider:string;amount_cents:number;reason:string;currency:string;
    review_required?:boolean;guest_cancellation_id?:string|null;deposit_guest_allocation?:Array<{guestIndex:number;amountCents:number}>|null;
    declined_at?:string|null;decline_reason?:string|null;retention_id?:string|null}>;
  reviewItems:Array<{id:string;payment_id:string;kind:'dispute'|'external_refund';external_id:string;amount_cents:number;currency:string;status:string;provider_status:string}>;
  failedTasks:Array<{id:string;kind:string;subject_id:string;attempts:number;last_error:string|null}>;
  deliveries:Array<{id:string;order_id:string;entity_type:string;status:string;attempts:number;created_at:string;sent_at:string|null}>;
  giftTemplates:Array<{id:string;name:string;names:Record<string,string>;face_value_cents:number;sale_price_cents:number;valid_days:number|null;scope:'location'|'org';online_sale:boolean;active:boolean}>;
}
export function useCommerceQuery(){
  const {membershipId,status}=useSession();
  return useQuery({queryKey:['desk','commerce',membershipId],queryFn:()=>apiGet<CommerceData>('/v1/desk/commerce'),
    enabled:status==='ready'&&membershipId!==null,refetchInterval:10_000});
}
