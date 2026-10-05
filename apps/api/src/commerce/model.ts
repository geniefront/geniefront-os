import type { HandlerArgs } from '../bus';
export type Tx = HandlerArgs<unknown>['tx'];
export type Ctx = HandlerArgs<unknown>['ctx'];
export interface PurchaseSnapshot {
  version:1; kind:'gift_card'|'package'|'deposit'|'customer_membership'; name:string; templateId:string|null;
  amountCents:number; currency:string; faceValueCents:number; sessions:number;
  serviceIds:string[]; scope:'location'|'org'; validDays:number|null;
  coverageMode:'bundle'|'any_included'; commissionBasis:'face'|'sale'|'catalog_price'|'sale_price'|'zero';
  recipientName:string|null; recipientNote:string|null; recipientEmail:string|null;
  consentVersion:string; consentAt:string;
  reason?:string|null;
  unitAllocationVersion?:2;
  depositHoldId?:string;
  depositQuoteId?:string;
  appointmentId?:string;
  serviceTotalCents?:number;
  depositPolicy?:Record<string,unknown>;
  membership?:import('../handlers/customerMembership').MembershipSnapshot;
}
export interface OrderRow { id:string;kind:string;channel:string;status:string;amount_cents:number;currency:string;
  customer_id:string|null;account_id:string|null;asset_id:string|null;snapshot:PurchaseSnapshot;request_hash:string; }
export interface PaymentRow { id:string;order_id:string;provider:string;method:string;status:string;amount_cents:number;
  currency:string;stripe_account_id:string|null;livemode:boolean;payment_intent_id:string|null;checkout_session_id:string|null; }
