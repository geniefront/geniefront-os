import {z} from 'zod';
/** The server hashes current services, original policy and every remaining payment source. */
export const depositAdjustmentConsent=z.object({accepted:z.literal(true),quoteHash:z.string().regex(/^[a-f0-9]{64}$/)});
export interface DepositAdjustmentQuote {
 quoteHash:string;currency:string;serviceTotalCents:number;requiredCents:number;availableCents:number;requestCents:number;excessCents:number;
 previousServiceTotalCents:number;hasConfirmedBooking:boolean;expiresAt:string|null;purpose:'replacement'|'supplement'|'none';
}
