import {createHash} from 'node:crypto';
import {commerceFingerprint} from '@gf/payroll';
export interface PurchaseQuoteTerms{kind:string;templateId:string|null;currency:string;amountCents:number;faceValueCents:number;sessions:number;validDays:number|null;serviceIds:string[];scope:string;coverageMode:string;}
/** The browser carries this server quote; payment preparation recomputes it before creating any customer/order. */
export function purchaseQuoteHash(terms:PurchaseQuoteTerms){
 const {kind,templateId,currency,amountCents,faceValueCents,sessions,validDays,scope,coverageMode}=terms;
 return createHash('sha256').update(commerceFingerprint({kind,templateId,currency:currency.toLowerCase(),amountCents,faceValueCents,sessions,validDays,scope,coverageMode,serviceIds:[...terms.serviceIds].sort()})).digest('hex');
}
