import { API_BASE,ApiError } from './api';
export interface Product {id:string;name:string;priceCents:number;faceValueCents?:number;sessions?:number;validDays?:number|null;serviceNames?:string[];scope?:'location'|'org';coverageMode?:'bundle'|'any_included';quoteHash?:string;}
export interface CommerceCatalog {shopName:string;currency:string;available:boolean;gifts:Product[];packages:Product[];}
export interface PurchaseStatus {timezone?:string;order:{id:string;kind:string;status:string;amount_cents:number;currency:string};paymentStatus:string;checkoutUrl:string|null;refundedCents?:number;pendingRefundCents?:number;
  asset:{can_redeem?:boolean;code?:string;balance_cents?:number;remaining_sessions?:number;total_sessions?:number;status:string;expires_at:string|null}|null;}
export async function commerceApi<T>(slug:string,path:string,options:{body?:unknown;token?:string;signal?:AbortSignal}={}):Promise<T> {
  const response=await fetch(`${API_BASE}/v1/public/shops/${encodeURIComponent(slug)}/commerce${path}`,{
    method:options.body===undefined?'GET':'POST',signal:options.signal,
    headers:{'Content-Type':'application/json',...(options.token?{'X-GF-Commerce-Token':options.token}:{})},
    ...(options.body===undefined?{}:{body:JSON.stringify(options.body)}),cache:'no-store',
  });
  const json=await response.json();if(!response.ok)throw new ApiError(json.code??'INTERNAL',response.status,json.details??{});return json as T;
}
export function savePurchaseAccess(slug:string,orderId:string,token:string):void {sessionStorage.setItem(`gf-commerce-v1:${slug}:${orderId}`,token);}
export function loadPurchaseAccess(slug:string,orderId:string):string|null {try{return sessionStorage.getItem(`gf-commerce-v1:${slug}:${orderId}`);}catch{return null;}}
