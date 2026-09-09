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
  /**
   * 这一行的付费状态由谁说了算（迁移 0120）：
   * `none` 从未接计费 · `stripe` 订阅在 Stripe · `license` 运营签发的订阅码。
   *
   * ⚠️ 界面必须据此分叉：`license` 的门店**没有** Stripe 客户门户可去 ——
   * 把「管理订阅」按钮给他会打开一个 404，而他要续期是找我们，不是找 Stripe。
   */
  billingSource: string;
  /** license 模式下的到期时刻（与 currentPeriodEnd 镜像同一个值） */
  licensePeriodEnd: string | null;
  trialEndsAt: string | null;
  trialing: boolean;
  /**
   * 老板已在客户门户点了取消，订阅到期即止。
   *
   * ⚠️ 这种情况下 `subscriptionStatus` 仍然是 `active` —— 界面必须据此
   * 把「本期结束日」换成「到期后转为只读」。
   */
  cancelAtPeriodEnd: boolean;
  cancelAt: string | null;
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

/** 兑换订阅码 / 额度包码的结果（迁移 0120） */
export interface RedeemCodeResponse {
  kind: 'subscription' | 'quota_pack' | 'store_open';
  codePrefix: string;
  plan: string | null;
  periodEnd: string | null;
  unit: QuotaUnit | null;
  amount: number | null;
  balanceAfter: number | null;
  invoiceId: string | null;
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