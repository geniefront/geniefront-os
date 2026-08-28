export interface MerchantBalanceResponse {
  availableBalanceCents: number;
  pendingPayoutsCents: number;
  bankAccount: {
    bankName: string;
    last4: string;
    status: 'verified' | 'pending';
  };
  payoutSchedule: 'daily' | 'weekly' | 'manual';
  nextPayoutEstimatedAt: string;
  monthlyGmvCents: number;
  processingFeeCents: number;
  netCaptureRateBp: number;
}

export interface BankPayoutBatchItem {
  id: string;
  payoutId: string;
  amountCents: number;
  feeCents: number;
  netCents: number;
  transactionCount: number;
  bankAccount: string;
  status: 'paid' | 'in_transit' | 'failed';
  arrivalDate: string;
  createdAt: string;
}

export interface BankPayoutBatchesResponse {
  batches: BankPayoutBatchItem[];
}

export interface PayrollBatchItem {
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
  status: 'paid' | 'pending' | 'draft';
}

export interface PayrollBatchesResponse {
  rows: PayrollBatchItem[];
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
