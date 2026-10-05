/** Operating totals, grouped by original currency. These are not accounting revenue recognition. */
export interface CommerceDayCurrency {
 currency:string;
 sales:Array<{kind:string;receivedCents:number;refundedCents:number;paymentCount:number;refundCount:number}>;
 offlineCashReceivedCents:number;offlineCashRefundedCents:number;
 offlineCardReceivedCents:number;offlineCardRefundedCents:number;
 stripeReceivedCents:number;stripeRefundedCents:number;
 redemptions:Array<{kind:string;appliedCents:number;returnedCents:number}>;
 giftFaceRemainingCents:number;packageUnitsRemaining:number;unlimitedPackageCount:number;packageFundedRemainingCents:number;
 membershipUnitsRemaining:number;membershipPlannedUnits:number;membershipPlannedValueCents:number;
 serviceRefundCreditIssuedCents:number;depositRemainingCents:number;depositRetainedCents:number;
}
export interface CommerceDaySummary {
 version:1;businessDate:string;throughDate:string;timezone:string;cutoff:string;from:string;to:string;
 currencies:CommerceDayCurrency[];
 settlements:Array<{currency:string;grossCents:number;feeCents:number;netCents:number;paymentCount:number;refundCount:number}>;
 unclassifiedRedemptionCount:number;pendingSettlementCount:number;
 payouts:Array<{id:string;currency:string;amountCents:number;status:string;automatic:boolean;arrivalAt:string}>;
}

/** Human-readable export rows; callers retain their existing CSV escaping. */
export function commerceDayExportRows(summary:CommerceDaySummary):string[][]{
 const rows:string[][]=[[],['Customer prepayments (separate from service revenue)',`${summary.businessDate} — ${summary.throughDate}`],['Currency','Product','Received','Refunded']];
 const money=(cents:number)=>(cents/100).toFixed(2);
 for(const c of summary.currencies)for(const s of c.sales)rows.push([c.currency,s.kind,money(s.receivedCents),money(s.refundedCents)]);
 rows.push(['Currency','Channel','Received','Returned']);for(const c of summary.currencies)rows.push([c.currency,'offline cash',money(c.offlineCashReceivedCents),money(c.offlineCashRefundedCents)],[c.currency,'offline terminal / external',money(c.offlineCardReceivedCents),money(c.offlineCardRefundedCents)],[c.currency,'online Stripe',money(c.stripeReceivedCents),money(c.stripeRefundedCents)]);
 rows.push(['Currency','Asset','Applied to services','Returned to assets']);for(const c of summary.currencies)for(const r of c.redemptions)rows.push([c.currency,r.kind,money(r.appliedCents),money(r.returnedCents)]);
 rows.push(['Currency','End-of-period ledger balance','Value']);for(const c of summary.currencies)rows.push([c.currency,'gift face balance',money(c.giftFaceRemainingCents)],[c.currency,'package units',String(c.packageUnitsRemaining)],[c.currency,'unlimited package contracts',String(c.unlimitedPackageCount)],[c.currency,'package funded value',money(c.packageFundedRemainingCents)],[c.currency,'issued membership units',String(c.membershipUnitsRemaining)],[c.currency,'planned membership units',String(c.membershipPlannedUnits)],[c.currency,'planned membership value',money(c.membershipPlannedValueCents)],[c.currency,'unapplied deposit',money(c.depositRemainingCents)],[c.currency,'retained deposit in period',money(c.depositRetainedCents)],[c.currency,'service refunds issued as store credit',money(c.serviceRefundCreditIssuedCents)]);
 rows.push(['Currency','Stripe gross','Stripe fees','Stripe net']);for(const s of summary.settlements)rows.push([s.currency,money(s.grossCents),money(s.feeCents),money(s.netCents)]);
 rows.push(['Historical redemptions requiring review',String(summary.unclassifiedRedemptionCount)]);
 rows.push(['Pending Stripe settlement facts',String(summary.pendingSettlementCount)],['Currency','Payout transfer (not new receipts)','Provider status']);for(const p of summary.payouts)rows.push([p.currency,money(p.amountCents),p.status]);return rows;
}
