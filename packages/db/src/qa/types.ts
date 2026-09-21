export const QA_SCENARIO_IDS = [
  'fresh_owner',
  'setup_incomplete',
  'growth_setup',
  'empty_shop',
  'essential_trial',
  'growth_active',
  'voice_active',
  'past_due',
  'multi_location_owner',
  'owner',
  'manager_or_front_desk',
  'tech_only',
  'busy_shop',
  'gift_card_shop',
  'day_close_ready',
  'ten_dlc_pending',
  'storefront_pending',
  'support_request_open',
  'platform_operator',
  'revoked_platform_operator',
] as const;

export type QaScenarioId = (typeof QA_SCENARIO_IDS)[number];

export const isQaScenarioId = (v: unknown): v is QaScenarioId =>
  typeof v === 'string' && (QA_SCENARIO_IDS as readonly string[]).includes(v);

export const QA_PASSWORD = 'GenieQa!2026';
export const QA_SEED_MARKER = 'v2';

export type CanonicalPlan = 'essential' | 'growth' | 'voice_booking';
export type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'canceled';
export type LocationStatus = 'setup' | 'trial' | 'active' | 'past_due' | 'suspended' | 'closed';
export type RoleKey = 'owner' | 'manager' | 'front_desk' | 'senior_tech' | 'tech';

export type QaLogin = {
  key: string;
  email: string;
  fullName: string;
  role: RoleKey | 'platform_super_admin' | 'platform_support_revoked' | 'none';
};

export type QaSnapshot = {
  scenario: QaScenarioId;
  orgCount: number;
  locationCount: number;
  membershipCount: number;
  customerCount: number;
  serviceCount: number;
  appointmentCount: number;
  ticketCount: number;
  paymentCount: number;
  giftCardCount: number;
  giftCardLedgerSum: number;
  queueCount: number;
  dayCloseCount: number;
  tenDlcStatus: string | null;
  storefrontStatus: string | null;
  supportStatuses: string[];
  plan: string | null;
  subscriptionStatus: string | null;
  trialEndsInFuture: boolean | null;
  locationStatus: string | null;
  loginEmails: string[];
  roleKeys: string[];
};
