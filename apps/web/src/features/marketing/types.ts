export interface GiftCardView {
  id: string;
  code: string;
  faceValueCents: number;
  salePriceCents: number;
  balanceCents: number;
  scope: string;
  recipientName: string | null;
  purchaserName: string | null;
  status: string;
  expiresAt: string | null;
  createdAt: string;
}

export interface PackageTemplateView {
  id: string;
  name: string;
  priceCents: number;
  catalogValueCents: number | null;
  savingsCents: number | null;
  serviceId: string;
  serviceName: string;
  serviceIds: string[];
  serviceNames: string[];
  totalUnits: number;
  validDays: number | null;
  active: boolean;
}

export interface CustomerPackageView {
  id: string;
  customerId: string;
  customerName: string;
  templateId: string;
  templateName: string;
  serviceName: string;
  serviceNames: string[];
  totalUnits: number;
  remainingUnits: number;
  expiresAt: string | null;
  status: string;
  createdAt: string;
}

export interface CouponTemplateView {
  id: string;
  code: string;
  name: string;
  kind: 'amount' | 'percent';
  discountAmountCents: number;
  discountPercentBp: number;
  minSpendCents: number;
  validDays: number | null;
  active: boolean;
}

export interface LoyaltyRuleView {
  earnRateBp: number;
  redeemRateBp: number;
  minRedeemPoints: number;
  active: boolean;
}

export interface CustomerPointsView {
  customerId: string;
  customerName: string;
  phone: string | null;
  points: number;
  lifetimePoints: number;
}

export interface PackagesQueryResponse {
  templates: PackageTemplateView[];
  userPackages: CustomerPackageView[];
  availableServices: Array<{ id: string; name: string; priceCents: number }>;
}

export interface CouponsQueryResponse {
  coupons: CouponTemplateView[];
}

export interface LoyaltyQueryResponse {
  rules: LoyaltyRuleView;
  customers: CustomerPointsView[];
}

export interface GiftCardsQueryResponse {
  giftCards: GiftCardView[];
  total?: number;
  rows?: GiftCardView[];
}

export interface SavePackageTemplateInput {
  templateId?: string;
  name: string;
  priceCents: number;
  serviceIds: string[];
  sessions: number;
  validDays?: number;
  active?: boolean;
}

export interface IssuePackageInput {
  /** 已知客户 ID 时直接传；与 `customer` 二选一。 */
  customerId?: string;
  /** 前台只报了姓名（可选附手机号）时传这个，由后端解析成真实客户。 */
  customer?: {
    name: string;
    phoneE164?: string;
    email?: string;
  };
  templateId: string;
  soldPriceCentsOverride?: number;
}

export interface RedeemPackageInput {
  customerPackageId: string;
  ticketId?: string;
  units?: number;
}

export interface SaveCouponTemplateInput {
  couponId?: string;
  code: string;
  name: string;
  kind: 'amount' | 'percent';
  discountAmountCents?: number;
  discountPercentBp?: number;
  minSpendCents?: number;
  validDays?: number;
  active?: boolean;
}

export interface VoidCouponInput {
  couponId: string;
}

export interface SaveLoyaltyRulesInput {
  earnRateBp: number;
  redeemRateBp: number;
  minRedeemPoints?: number;
  active?: boolean;
}

export interface AdjustLoyaltyPointsInput {
  customerId: string;
  pointsDelta: number;
  reason: string;
}

export interface IssueGiftCardInput {
  faceValueCents: number;
  salePriceCents?: number;
  recipientName?: string;
  purchaserCustomerId?: string;
  recipientNote?: string;
}

export interface AdjustGiftCardInput {
  giftCardId: string;
  amountCents: number;
  reason: string;
}
