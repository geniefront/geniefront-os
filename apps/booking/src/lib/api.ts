/**
 * 公开预约 API 的客户端（docs/13）。
 *
 * 和另外三个端最大的不同：**没有身份**。带的只有一串公开 key ——
 * 它明文躺在这页的 URL 里，谁都看得到，这是设计如此（docs/13 §3）。
 *
 * ⚠️ 这一层只做三件事：拼请求、把错误收敛成 `ApiError`、把 409/429
 * 这两种「不是 bug 而是常态」的分支标出来。
 * 任何业务判断都不在这里 —— 时间能不能订、价格是多少，一律以服务端为准。
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
  /** 时段被人抢先订走了 —— 这条路上最常见的失败，前端要重拉空档 */
  get isTaken(): boolean {
    return this.status === 409
      && ['RESOURCE_CONFLICT', 'LOCATION_OVER_CAPACITY', 'STAFF_OVER_CAPACITY'].includes(this.code);
  }
  get isRateLimited(): boolean { return this.status === 429; }
}

function publicKey(): string {
  const q = new URLSearchParams(location.search);
  return (q.get('k') ?? q.get('key') ?? '').trim();
}

async function call<T>(
  method: 'GET' | 'POST', path: string, body?: unknown, idem?: string,
): Promise<T> {
  const key = publicKey();
  if (!key) throw new ApiError('NO_PUBLIC_KEY', 400);

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-GF-Public-Key': key,
        ...(idem ? { 'Idempotency-Key': idem } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    // 断网、被拦截、CORS 掐掉 —— 对客人来说都是同一件事：现在订不了
    throw new ApiError('NETWORK', 0);
  }

  const json = await res.json().catch(() => ({} as Record<string, unknown>));
  if (!res.ok) {
    const j = json as { code?: string; details?: Record<string, unknown> };
    throw new ApiError(j.code ?? 'INTERNAL', res.status, j.details ?? {});
  }
  return json as T;
}

export const hasKey = (): boolean => publicKey().length > 0;

// ── 返回类型 ────────────────────────────────────────────────────────────────

export interface Shop {
  name: string;
  slug: string;
  timezone: string;
  currency: string;
  phone: string | null;
  address: Record<string, string> | null;
  businessHours: Record<string, { open: string; close: string } | null>;
  locales: string[];
  onlineBooking: {
    enabled: boolean;
    maxDaysAhead: number;
    minMinutesAhead: number;
    requirePhoneVerification: boolean;
    cancelCutoffHours: number;
  };
  turnstileSiteKey: string | null;
}

export interface Service {
  id: string;
  categoryId: string | null;
  name: string;
  description: string | null;
  durationMin: number;
  priceCents: number;
  /** true = 加项，只能加在主项目上（docs/13 §4.2） */
  isAddon: boolean;
}

export interface Catalog {
  categories: Array<{ id: string; name: string }>;
  /** 能单独订的项目 */
  services: Service[];
  /** ⭐ 加项。只能挂在 `items[].addonIds` 上，服务端不接受它们当主项目 */
  addons: Service[];
}

export interface Availability {
  date: string;
  timezone: string;
  durationMin: number;
  slots: Array<{ startsAt: string; staff: { id: string; displayName: string } | null }>;
  staff: Array<{ id: string; displayName: string; avatarUrl: string | null }>;
}

export interface Booked {
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
  customer: { name: string; phone: string; email?: string; smsOptIn: boolean };
  items: Array<{ serviceId: string; addonIds: string[]; staffId: string | null; startsAt: string }>;
  partySize: number;
  notes?: string;
  website: string;
  formElapsedMs: number;
}

export const getShop = (locale?: string) =>
  call<Shop>('GET', `/public/v1/shop${locale ? `?locale=${encodeURIComponent(locale)}` : ''}`);

export const getServices = (locale?: string) =>
  call<Catalog>('GET', `/public/v1/services${locale ? `?locale=${encodeURIComponent(locale)}` : ''}`);

export const getAvailability = (
  q: { date: string; serviceId: string; addonIds?: readonly string[]; staffId?: string | null },
) =>
  call<Availability>('GET', `/public/v1/availability?${new URLSearchParams({
    date: q.date, serviceId: q.serviceId,
    // ⚠️ 加项会加长时长，所以它必须进这个查询 —— 少传的话拿到的是
    // 「只做主项目」的空档，客人选了一个放不下他这一单的时间
    ...(q.addonIds?.length ? { addonIds: q.addonIds.join(',') } : {}),
    ...(q.staffId ? { staffId: q.staffId } : {}),
  })}`);

export const book = (input: BookInput, idem: string) =>
  call<Booked>('POST', '/public/v1/bookings', input, idem);

export const cancel = (id: string, manageToken: string) =>
  call<{ bookingId: string; status: string }>(
    'POST', `/public/v1/bookings/${id}/cancel`, { manageToken });
