export type QuotaUnit = "credit" | "voice_minute";

export interface LedgerRow {
  id: string;
  kind: string;
  unit: QuotaUnit;
  amount: number;
  balanceAfter: number;
  paidCents: number | null;
  source: string | null;
  reason: string | null;
  at: string;
}

export interface QuotaView {
  unit: QuotaUnit;
  included: { used: number; total: number; remaining: number };
  balance: number;
  unitsPerTopup: number;
  autoTopup: {
    enabled: boolean;
    thresholdUnits: number;
    failures: number;
    lastAt: string | null;
  };
  usedThisMonth: number;
}

export interface BillingView {
  plan: string;
  subscriptionStatus: string;
  currentPeriodEnd: string | null;
  hasSubscription: boolean;
  trialEndsAt: string | null;
  trialing: boolean;
  hasPaymentMethod: boolean;
  paymentMethodLabel: string | null;
  topupPriceCents: number;
  quotas: QuotaView[];
  recent: LedgerRow[];
}

export interface BillingResponse {
  billing: BillingView | null;
  autoTopup: unknown;
}

export interface SetAutoTopupInput {
  unit: QuotaUnit;
  enabled: boolean;
  thresholdUnits: number;
}

export interface BillingInvoiceItem {
  id: string;
  invoiceNumber: string;
  period: string;
  description: string;
  amountCents: number;
  status: 'paid' | 'pending' | 'failed';
  date: string;
  receiptPdfUrl?: string | null;
}

export interface BillingInvoicesResponse {
  invoices: BillingInvoiceItem[];
}

export interface TaxProfile {
  legalEntityName: string;
  taxId: string;
  billingEmail: string;
}

export interface SaveTaxProfileInput {
  legalEntityName: string;
  taxId: string;
  billingEmail: string;
}

export type TopupResponse =
  | { ok: true; unit: QuotaUnit; units: number; balanceAfter: number }
  | { ok: false; pending: true; status: string };