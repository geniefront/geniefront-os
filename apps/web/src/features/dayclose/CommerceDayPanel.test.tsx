import {render,screen,within,cleanup} from '@testing-library/react';
import {it,expect,vi,afterEach} from 'vitest';
import {CommerceDayPanel} from './CommerceDayPanel';
import {commerceDayExportRows,type CommerceDaySummary} from '@gf/contracts';
vi.mock('@/LanguageContext',()=>({useLanguage:()=>({language:'en'})}));afterEach(cleanup);
const summary:CommerceDaySummary={version:1,businessDate:'2026-10-02',throughDate:'2026-10-02',timezone:'America/Los_Angeles',cutoff:'04:00:00',from:'2026-10-02T11:00:00Z',to:'2026-10-03T11:00:00Z',currencies:[{currency:'usd',sales:[{kind:'gift_card',receivedCents:8000,refundedCents:5600,paymentCount:1,refundCount:1}],offlineCashReceivedCents:8000,offlineCashRefundedCents:5600,offlineCardReceivedCents:0,offlineCardRefundedCents:0,stripeReceivedCents:0,stripeRefundedCents:0,redemptions:[{kind:'gift_card',appliedCents:3000,returnedCents:3000}],giftFaceRemainingCents:3000,packageUnitsRemaining:1,unlimitedPackageCount:0,packageFundedRemainingCents:5000,membershipUnitsRemaining:1,membershipPlannedUnits:2,membershipPlannedValueCents:19800,serviceRefundCreditIssuedCents:0,depositRemainingCents:2000,depositRetainedCents:0}],settlements:[{currency:'eur',grossCents:7100,feeCents:200,netCents:6900,paymentCount:1,refundCount:0}],unclassifiedRedemptionCount:0,pendingSettlementCount:1,payouts:[{id:'payout',currency:'eur',amountCents:1000,status:'failed',automatic:false,arrivalAt:'2026-10-04T00:00:00Z'}]};
it('keeps prepaid receipt, service use, restored face, settlement currency and failed bank transfer separate',()=>{
 render(<CommerceDayPanel summary={summary}/>);
 const tables=screen.getAllByRole('table');expect(within(tables[0]!).getByText('$80.00')).toBeInTheDocument();expect(within(tables[0]!).getByText('$56.00')).toBeInTheDocument();
 expect(within(tables[1]!).getAllByText('$30.00')).toHaveLength(2);expect(screen.getByText(/EUR · Gross €71.00 · Fees €2.00 · Net €69.00/)).toBeInTheDocument();
 expect(screen.getByText(/€10.00 · Payout failed/)).toBeInTheDocument();expect(screen.getByRole('status')).toHaveTextContent('Settlement facts still pending: 1');
 expect(screen.getByText('Gift card face balance').nextElementSibling).toHaveTextContent('$30.00');expect(screen.queryByText('$100.00')).not.toBeInTheDocument();
});

it('exports the same currency-separated receipts, restored assets and bank transfers',()=>{
 const rows=commerceDayExportRows(summary);
 expect(rows).toContainEqual(['usd','gift_card','80.00','56.00']);expect(rows).toContainEqual(['usd','gift_card','30.00','30.00']);
 expect(rows).toContainEqual(['eur','71.00','2.00','69.00']);expect(rows).toContainEqual(['usd','gift face balance','30.00']);expect(rows).toContainEqual(['eur','10.00','failed']);
});
