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
  serviceId: string;
  serviceName: string;
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
}

export interface SavePackageTemplateInput {
  templateId?: string;
  name: string;
  priceCents: number;
  serviceId: string;
  totalUnits: number;
  validDays?: number;
  active?: boolean;
}

export interface IssuePackageInput {
  customerId: string;
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
