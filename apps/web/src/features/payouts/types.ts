export interface EarningsEstimateItem {
  membershipId: string;
  name: string;
  jobTitle: string;
  baseSalaryCents: number;
  serviceSalesCents: number;
  serviceCommissionCents: number;
  retailSalesCents: number;
  retailCommissionCents: number;
  cardTipsCents: number;
  bonusCents: number;
  deductionsCents: number;
  netPayCents: number;
  status: 'estimate';
}

export interface EarningsEstimatesResponse {
  rows: EarningsEstimateItem[];
}

export interface ClawbackItem {
  id: string;
  ticketId: string;
  customerName: string;
  staffName: string;
  refundAmountCents: number;
  clawbackCommissionCents: number;
  reason: string;
  date: string;
}

export interface ClawbacksResponse {
  rows: ClawbackItem[];
}
