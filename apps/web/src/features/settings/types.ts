/**
 * 系统设置类型定义。
 *
 * 与 `GET /v1/desk/settings` 及 `location.*` / `catalog.*` / `staff.*` / `device.*` / `settings.*` 命令严格对齐。
 */

export interface LocationSettings {
  name: string;
  slug?: string;
  timezone: string;
  businessType: string;
  phone?: string;
  email?: string;
  addressStreet?: string;
  addressCity?: string;
  addressState?: string;
  addressZip?: string;
  businessHours: Record<string, { open: string; close: string } | null>;
  businessDayCutoff: string;
  status: string;
  hasAddress: boolean;
  profileConfirmedAt: string | null;
  /**
   * 预约确认 / 改期 / 取消 / 提醒的邮件是否抄送门店自己一份。
   * ⚠️ 抄送地址取上面的 `email`，为空则不抄送。
   */
  appointmentEmailCopyToShop?: boolean;
}

export interface ServiceItem {
  id: string;
  name: Record<string, string>;
  displayName: string;
  durationMin: number;
  basePriceCents: number;
  taxable: boolean;
  onlineBookable: boolean;
  isAddon: boolean;
  staffCount: number;
  requiredSkillIds: string[];
  active: boolean;
}

export interface StaffItem {
  membershipId: string;
  name: string;
  isBookable: boolean;
  maxConcurrent: number;
  levelKey: string | null;
  inRotation: boolean;
  roleKeys: string[];
  phoneE164: string | null;
  hasAccount: boolean;
  liveSessions: number;
}

export interface StaffLevelItem {
  id: string;
  key: string;
  name: string;
}

export interface AllowedOriginItem {
  id: string;
  origin: string;
  label: string | null;
}

export interface OnlineBookingConfig {
  enabled: boolean;
  maxDaysAhead: number;
  minMinutesAhead: number;
  requirePhoneVerification: boolean;
  cancelCutoffHours: number;
  rescheduleEnabled: boolean;
  rescheduleCutoffHours?: number;
  selfRescheduleMax: number;
  slotIntervalMinutes?: 15 | 30 | 60;
  depositRequired?: boolean;
  depositAmountCents?: number;
  requireCardOnFile?: boolean;
  allowClientPickStaff?: boolean;
}

export interface GuestSettings {
  publicKey: string;
  slug: string;
  allowedOrigins: AllowedOriginItem[];
  onlineBooking: OnlineBookingConfig;
  onlineBookableCount: number;
}

export interface PhoneSettings {
  storefrontE164: string | null;
  transferTargetE164: string | null;
  aiVoiceE164: string | null;
  forwardingMode: string | null;
}

export interface PhoneAssistantSettings {
  greetingPrompt?: string;
  forwardPhoneNumber?: string;
  autoBookEnabled?: boolean;
  tone?: string;
  voiceTone?: string;
  afterHoursVoicemail?: boolean;
}

export interface CheckoutSettings {
  salesTaxRatePercent: number;
  taxCalculationMode: 'exclusive' | 'inclusive';
  suggestedTipPercentages: number[];
  allowCustomTip: boolean;
  defaultCashFloatCents: number;
  receiptFooterMessage: string;
  autoPrintReceipt: boolean;
  autoSendSmsReceipt: boolean;
  checkoutTiming: 'service_then_tip' | 'upfront_combined' | 'after_service_combined';
}

export interface HardwareIntakeConfig {
  requireSignature: boolean;
  requireHealthAllergies: boolean;
  requirePressurePreference: boolean;
  requireBodySorenessMap: boolean;
  autoCreateCrmProfile: boolean;
  autoPromptTipPercentages: boolean;
  waiverTitle: string;
  waiverContent: string;
  autoSyncToProfile: boolean;
}

export interface TenDlcStatusInfo {
  status: 'not_submitted' | 'pending_review' | 'approved' | 'rejected';
  legalBusinessName?: string | null;
  ein?: string | null;
  businessStructure?: string | null;
  registeredAddress?: string | null;
  repName?: string | null;
  repTitle?: string | null;
  repEmail?: string | null;
  repPhone?: string | null;
  optInMethod?: string | null;
  sampleMessages?: string[];
  submittedAt?: string | null;
  submittedByMembershipId?: string | null;
  reviewedAt?: string | null;
  notes?: string | null;
}

export interface WebhookConfigItem {
  id: string;
  url: string;
  events: string[];
  active: boolean;
  createdAt: string;
}

/**
 * 发给店主的账单类邮件用哪种语言。
 *
 * ⚠️ 与界面语言（`staff.setLocale`，按人存）是两件事。
 * 顾客侧的邮件与短信恒为英语，不受该设置影响。
 */
export type EmailLocale = 'en' | 'zh-Hans' | 'zh-Hant' | 'ko' | 'vi' | 'es';

export interface DeskSettings {
  location: LocationSettings;
  /** 账单类邮件的语言。事实源是 organizations.default_locale */
  emailLocale?: EmailLocale;
  services: ServiceItem[];
  staff: StaffItem[];
  levels: StaffLevelItem[];
  skills: Array<{ id: string; key: string; name: string }>;
  guest: GuestSettings;
  phone: PhoneSettings;
  phoneAssistant?: PhoneAssistantSettings;
  checkout?: CheckoutSettings;
  tenDlc?: TenDlcStatusInfo;
  intakeWaiver?: HardwareIntakeConfig;
  webhooks?: WebhookConfigItem[];
}

export interface SaveLocationProfileInput {
  name?: string;
  slug?: string;
  timezone?: string;
  businessType?: 'nail' | 'massage' | 'foot_spa' | 'lash' | 'scalp' | 'hair' | 'mixed';
  phone?: string;
  email?: string;
  addressStreet?: string;
  addressCity?: string;
  addressState?: string;
  addressZip?: string;
  businessDayCutoff?: string;
  appointmentEmailCopyToShop?: boolean;
}

export interface SaveBusinessHoursInput {
  hours: Record<string, { open: string; close: string } | null>;
}

export interface SaveServiceInput {
  serviceId?: string;
  name: Record<string, string>;
  durationMin: number;
  basePriceCents: number;
  taxable?: boolean;
  onlineBookable?: boolean;
  isAddon?: boolean;
  staffCount?: number;
  requiredSkillIds?: string[];
  active?: boolean;
}

export interface ArchiveServiceInput {
  serviceId: string;
}

export interface SaveStaffProfileInput {
  /** 不传就是在当前门店新增一位员工。 */
  membershipId?: string;
  name?: string;
  displayName?: string | Record<string, string>;
  isBookable?: boolean;
  maxConcurrentAppointments?: number;
  levelId?: string | null;
  inRotation?: boolean;
}

export interface SetRotationParticipationInput {
  membershipId: string;
  inRotation: boolean;
  businessDate?: string;
}

export interface SaveOnlineBookingInput {
  enabled: boolean;
  maxDaysAhead?: number;
  minMinutesAhead?: number;
  requirePhoneVerification?: boolean;
  cancelCutoffHours?: number;
  rescheduleEnabled?: boolean;
  rescheduleCutoffHours?: number;
  selfRescheduleMax?: number;
  slotIntervalMinutes?: 15 | 30 | 60;
  depositRequired?: boolean;
  depositAmountCents?: number;
  requireCardOnFile?: boolean;
  allowClientPickStaff?: boolean;
}

export interface AddWebOriginInput {
  origin: string;
  label?: string;
}

export interface RemoveWebOriginInput {
  originId: string;
}

export interface IssueDeviceTokenInput {
  label: string;
}

export interface RevokeDeviceTokenInput {
  deviceId: string;
}

export interface SaveCheckoutInput {
  salesTaxRatePercent?: number;
  taxCalculationMode?: 'exclusive' | 'inclusive';
  suggestedTipPercentages?: number[];
  allowCustomTip?: boolean;
  defaultCashFloatCents?: number;
  receiptFooterMessage?: string | null;
  autoPrintReceipt?: boolean;
  autoSendSmsReceipt?: boolean;
  checkoutTiming?: 'service_then_tip' | 'upfront_combined' | 'after_service_combined';
}

export interface Apply10DlcInput {
  legalBusinessName: string;
  ein: string;
  businessStructure: 'llc' | 'corp' | 'sole_prop' | 'partnership';
  registeredAddress: string;
  repName: string;
  repTitle: string;
  repEmail: string;
  repPhone: string;
  optInMethod?: string;
  sampleMessages?: string[];
  sampleMessage1?: string;
  sampleMessage2?: string;
}

export interface SaveIntakeWaiverInput {
  waiverTitle?: string;
  waiverContent?: string | null;
  requireSignature?: boolean;
  requireHealthAllergies?: boolean;
  requirePressurePreference?: boolean;
  requireBodySorenessMap?: boolean;
  autoCreateCrmProfile?: boolean;
  autoPromptTipPercentages?: boolean;
  autoSyncToProfile?: boolean;
}

export interface SaveWebhooksInput {
  url: string;
  events?: string[];
  secret?: string;
  active?: boolean;
}
