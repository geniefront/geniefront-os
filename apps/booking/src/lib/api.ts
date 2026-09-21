import type { PublicBookingProfile } from '@gf/contracts';
/**
 * Public booking API client. The hosted page keeps the public key in memory
 * after slug bootstrap; it is never written back into the canonical URL.
 */

declare const __API_BASE__: string;
export const API_BASE = __API_BASE__;

export class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly details: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = 'ApiError';
  }
  get isTaken(): boolean {
    return this.status === 409
      && ['RESOURCE_CONFLICT', 'LOCATION_OVER_CAPACITY', 'STAFF_OVER_CAPACITY'].includes(this.code);
  }
  get isRateLimited(): boolean { return this.status === 429; }
}

let memoryPublicKey = '';

export function setPublicKey(key: string): void {
  memoryPublicKey = key;
}

export function getPublicKey(): string {
  return memoryPublicKey;
}

async function call<T>(
  method: 'GET' | 'POST', path: string, body?: unknown, idem?: string, publicKey?: string,
): Promise<T> {
  const key = publicKey ?? getPublicKey();
  if (!key && !path.startsWith('/public/v1/hosted/')) {
    throw new ApiError('NO_PUBLIC_KEY', 400);
  }

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(key ? { 'X-GF-Public-Key': key } : {}),
        ...(idem ? { 'Idempotency-Key': idem } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new ApiError('NETWORK', 0);
  }

  const json = await res.json().catch(() => ({} as Record<string, unknown>));
  if (!res.ok) {
    const j = json as { code?: string; details?: Record<string, unknown> };
    throw new ApiError(j.code ?? 'INTERNAL', res.status, j.details ?? {});
  }
  return json as T;
}

export interface Shop {
  team?: Availability["staff"];
  publicProfile?: Omit<PublicBookingProfile,"services" | "shopNotifications">;
  name: string;
  slug: string;
  timezone: string;
  currency: string;
  businessDayCutoff?: string;
  phone: string | null;
  address: Record<string, string> | string | null;
  businessHours: Record<string, { open: string; close: string; periods?: Array<{open:string;close:string}> } | null>;
  locales: string[];
  onlineBooking: {
    enabled: boolean;
    maxDaysAhead: number;
    minMinutesAhead: number;
    requirePhoneVerification: boolean;
    cancelCutoffHours: number;
    rescheduleEnabled?: boolean;
    rescheduleCutoffHours?: number;
    selfRescheduleMax?: number;
    allowClientPickStaff?: boolean;
    cancellationPolicyNotice?: string;
  };
  turnstileSiteKey: string | null;
  publicKey?: string;
}

export interface Service {
  onlineBookable?: boolean;
  staffCount?: number;
  guestCount?: number;
  imageUrl?: string | null;
  id: string;
  categoryId: string | null;
  name: string;
  description: string | null;
  durationMin: number;
  priceCents: number;
  isAddon: boolean;
}

export interface Catalog {
  categories: Array<{ id: string; name: string }>;
  services: Service[];
  addons: Service[];
}

/** 组合套餐（U10）：几个项目一起买走固定组合价。 */
export interface Bundle {
  id: string;
  version: number;
  name: string;
  description: string | null;
  priceCents: number;
  originalTotalCents: number;
  bundleDiscountCents: number;
  components: Array<{
    serviceId: string; name: string; qty: number; seq: number;
    listPriceCents: number; durationMin: number;
  }>;
  bookable: boolean;
}

export interface Availability {
  date: string;
  timezone: string;
  durationMin: number;
  slots: Array<{ startsAt: string; staff: { id: string; displayName: string } | null }>;
  staff: Array<{ id: string; displayName: string; avatarUrl: string | null; bio?:string|null }>;
}

export interface Booked {
  summary?: ManagedBooking;
  bookingId: string;
  confirmationCode: string | null;
  manageToken: string | null;
  replayed: boolean;
  startsAt: string;
  durationMin: number;
  status: string;
}

export interface BookInput {
  turnstileToken: string;
  locale?: string;
  customer: { name: string; phone: string; email?: string; smsOptIn: boolean; bookingSmsConsent?:boolean };
  items: Array<{ guestIndex?: number; guestIndices?: number[]; quotedPriceCents?: number; serviceId: string; addonIds: string[]; staffId: string | null; startsAt: string }>;
  /** 组合套餐选择（U10）。与 items 二选一，服务端展开定价。 */
  bundleSelections?: Array<{ bundleId: string; startsAt: string; expectedVersion?: number }>;
  partySize: number;
  notes?: string;
  website: string;
  formElapsedMs: number;
}

export const getHostedShop = (slug: string, locale = 'en') =>
  call<Shop>('GET', `/public/v1/hosted/shops/${encodeURIComponent(slug)}?locale=${encodeURIComponent(locale)}`);

export const getShop = (locale = 'en') =>
  call<Shop>('GET', `/public/v1/shop?locale=${encodeURIComponent(locale)}`);

export const getServices = (locale = 'en', publicKey?:string) =>
  call<Catalog>('GET', `/public/v1/services?locale=${encodeURIComponent(locale)}`,undefined,undefined,publicKey);

export const getBundles = (locale = 'en', publicKey?:string) =>
  call<{ bundles: Bundle[] }>('GET', `/public/v1/bundles?locale=${encodeURIComponent(locale)}`,undefined,undefined,publicKey);

export const getAvailability = (
  q: {
    date: string; serviceId?: string; bundleId?: string; addonIds?: readonly string[];
    staffId?: string | null; excludeBookingId?: string | null;
  },
) =>
  call<Availability>('GET', `/public/v1/availability?${new URLSearchParams({
    date: q.date,
    ...(q.bundleId ? { bundleId: q.bundleId } : { serviceId: q.serviceId ?? '' }),
    ...(q.addonIds?.length ? { addonIds: q.addonIds.join(',') } : {}),
    ...(q.staffId ? { staffId: q.staffId } : {}),
    ...(q.excludeBookingId ? { excludeBookingId: q.excludeBookingId } : {}),
  })}`);

export const book = (input: BookInput, idem: string, publicKey?:string) =>
  call<Booked>('POST', '/public/v1/bookings', input, idem,publicKey);

export interface GuestActions {
  canReschedule: boolean;
  canCancel: boolean;
  canRebook: boolean;
  reason: string | null;
  rescheduleCountLeft: number | null;
}

export interface ManagedBooking {
  bookingId: string;
  confirmationCode: string | null;
  status: string;
  startsAt: string;
  endsAt: string;
  timezone: string;
  durationMin: number;
  priceCents: number;
  specialistName: string | null;
  items: Array<{
    guestIndex?: number; guestIndices?: number[];
    serviceId: string;
    name: string;
    addonIds: string[];
    addonNames: string[];
    startsAt: string;
    endsAt: string;
    durationMin: number;
    priceCents: number;
    specialistName: string | null;
  }>;
  policy: {
    cancelCutoffHours: number;
    rescheduleEnabled: boolean;
    rescheduleCutoffHours: number;
    selfRescheduleMax: number;
  };
  actions: GuestActions;
}

export interface ManageBootstrap {
  publicKey: string;
  shop: Shop;
  booking: ManagedBooking;
}

export const loadManagedBooking = (slug: string, manageToken: string, locale = 'en') =>
  call<ManageBootstrap>('POST', '/public/v1/hosted/manage', { slug, manageToken, locale });

export const getManagedAvailability = (
  q: { slug: string; manageToken: string; date: string },
) =>
  call<Availability & { canReschedule: boolean; reason: string | null }>(
    'POST', '/public/v1/hosted/availability', q,
  );

export const cancelManagedBooking = (
  bookingId: string, manageToken: string, last4?: string, publicKey?:string,
) =>
  call<{ bookingId: string; status: string }>(
    'POST', `/public/v1/bookings/${bookingId}/cancel`,
    { manageToken, ...(last4 ? { last4 } : {}) },undefined,publicKey,
  );

export const rescheduleManagedBooking = (
  bookingId: string,
  args: { manageToken: string; last4?: string; startsAt: string; requestId?:string }, publicKey?:string,
) =>
  call<{ bookingId: string; status: string; startsAt: string; rescheduleCountLeft: number | null }>(
    'POST', `/public/v1/bookings/${bookingId}/reschedule`, args,undefined,publicKey,
  );

export interface PartySelection { guestIndex: number; guestIndices?: number[]; serviceId: string; addonIds: string[]; staffId: string | null }
export interface PartyPlanItem extends PartySelection { startsAt: string; endsAt: string; durationMin: number; priceCents: number }
export interface PartyAvailability {
  items?: Array<{eligibleStaffIds:string[]}>;
  date: string; timezone: string;
  plans: Array<{startsAt: string; items: PartyPlanItem[]}>;
  staff: Availability['staff'];
}
export const getPartyAvailability = (date: string, items: PartySelection[], publicKey?:string) =>
  call<PartyAvailability>('POST', '/public/v1/party-availability', {date,items},undefined,publicKey);
