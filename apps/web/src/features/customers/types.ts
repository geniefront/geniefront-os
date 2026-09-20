/**
 * 客户档案类型，与服务端 `GET /v1/desk/customers` 及 `/v1/desk/customers/:id` 对应。
 *
 * ## 两条必须遵守的呈现约束
 *
 * ⚠️ **金额为 null 不等于 0。** 不具备 `report.view` 权限时，服务端返回 null 而非 0 ——
 * 显示成 $0 会被读作「这位客人从没花过钱」，进而影响前台对他的接待方式。
 * null 一律显示为占位符。
 *
 * ⚠️ **手机号已由服务端按权限脱敏**（无 `customer.view_contact` 时形如 `617-***-1234`）。
 * 前端不得尝试还原，也不得据此推断权限。
 */

export interface CustomerListRow {
  id: string;
  displayName: string;
  phone: string | null;
  vipLevel: number;
  visitCount: number;
  lastVisitDate: string | null;
  /** 距上次到店天数。从未到店为 null。 */
  daysSinceLastVisit: number | null;
  noShowCount: number;
}

export interface CustomerGiftCard {
  id: string;
  code: string;
  balanceCents: number;
  faceValueCents: number;
  status: string;
  expiresAt: string | null;
}

export interface CustomerTicketRef {
  id: string;
  businessDate: string;
  status: string;
  /** 无 `report.view` 时为 null。 */
  totalCents: number | null;
  serviceNames: string[];
}

export interface CustomerFormRef {
  id: string;
  templateKey: string;
  submittedAt: string;
}

export interface CustomerDetail {
  id: string;
  displayName: string;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  email: string | null;
  locale: string | null;
  gender: string | null;
  birthday: string | null;
  vipLevel: number;
  tags: string[];
  notes: string | null;
  marketingSmsOptIn: boolean;
  marketingEmailOptIn: boolean;
  noShowCount: number;
  lateCancelCount: number;
  /** 非空表示该客户已被拉黑，界面须显著提示。 */
  blockedAt: string | null;
  blockedReason: string | null;
  source: string | null;
  /** 已合并的旧档案会指向合并后的目标 id。 */
  mergedIntoId: string | null;

  preferences: {
    preferredStaffIds: string[];
    avoidStaffIds: string[];
    preferredGender: string | null;
    allergies: unknown;
    freeNotes: string | null;
    profile: unknown;
  };

  visits: {
    total: number;
    firstAt: string | null;
    lastAt: string | null;
    /** ⚠️ 无 `report.view` 时为 null，不是 0。 */
    avgSpendCents: number | null;
    lifetimeSpendCents: number | null;
    daysSinceLastVisit: number | null;
  };

  giftCards: CustomerGiftCard[];
  recentTickets: CustomerTicketRef[];
  recentAppointments?: Array<{ id: string; startsAt: string; status: string }>;
  /**
   * 已提交的健康表索引。
   *
   * ⚠️ 此处只有索引，不含表单内容。查看内容需要 `customer.view_health_form`，
   * 且服务端**每次读取都会写入 `form_access_log`**（读也要审计）。
   * 因此不得在进入客户详情时预取内容 —— 那会为每一次浏览产生一条访问记录，
   * 使审计日志失去指证价值。必须由用户显式点击后再请求。
   */
  forms: CustomerFormRef[];
}

export interface SaveCustomerProfileInput {
  customerId?: string;
  name: string;
  phoneE164?: string;
  email?: string;
  vipLevel?: number;
  birthday?: string;
  tags?: string[];
  gender?: 'female' | 'male' | 'other' | 'unspecified';
  notes?: string;
  source?: string;
}

export interface SaveCustomerPreferencesInput {
  customerId: string;
  allergies?: {
    skinAllergies?: string[];
    fragranceSensitivities?: string[];
    medications?: string[];
    customNotes?: string;
  };
  preferredStaffIds?: string[];
  avoidStaffIds?: string[];
  freeNotes?: string;
}

export interface SetCustomerBlockedInput {
  customerId: string;
  blocked: boolean;
  reason?: string;
}

export interface MergeCustomersInput {
  targetCustomerId: string;
  sourceCustomerId: string;
}

export interface SendCustomerSmsInput {
  customerId: string;
  body: string;
}
