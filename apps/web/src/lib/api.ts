/**
 * API 客户端。所有写操作走 /v1/commands/:name —— 页面里不许直接 POST 裸接口
 * （宪法第 1 条）。
 */
import { supabase } from './supabase';
import { cache, readCache } from './offline';

declare const __API_BASE__: string;
export const API_BASE = __API_BASE__;

/** 后端返回的结构化错误。前台看到的是 messageKey 翻译后的母语文案 */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly details: Record<string, unknown>,
    readonly overridable: boolean,
    readonly status: number,
  ) {
    super(code);
    this.name = 'ApiError';
  }
}

/**
 * 当前门店的 membership id。
 *
 * 由 `SessionProvider` 在门店确定后注入。集中持有而非逐个调用点透传，
 * 是为了消除「某个请求漏带 X-Membership-Id」这一类只在特定页面复现的缺陷 ——
 * 服务端对缺失该头的请求一律返回 VALIDATION_FAILED，而调用栈中不易定位。
 */
let activeMembershipId: string | null = null;
let commandGuardOnline = true;

export function setActiveMembershipId(value: string | null): void {
  activeMembershipId = value;
}

/** 防止遗漏的普通按钮在离线时发出必然失败的写请求。权限仍由按钮与服务端双重判定。 */
export function setCommandGuard(online: boolean): void {
  commandGuardOnline = online;
}

export async function authHeaders(membershipId?: string): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) {
    onUnauthenticated?.();
    throw new ApiError('UNAUTHENTICATED', {}, false, 401);
  }
  const effective = membershipId ?? activeMembershipId;
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    ...(effective ? { 'X-Membership-Id': effective } : {}),
  };
}

/**
 * 认证失效回调。
 *
 * 由 `SessionProvider` 注册。access token 过期且刷新失败时，服务端返回 401；
 * 若不在此处统一处理，界面表现为一个用户无法理解的请求错误，
 * 且后续每次操作都会重复失败。集中在响应解析层处理，可覆盖全部请求路径。
 */
let onUnauthenticated: (() => void) | null = null;

export function setUnauthenticatedHandler(handler: (() => void) | null): void {
  onUnauthenticated = handler;
}

async function parse<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) onUnauthenticated?.();
    throw new ApiError(
      body.code ?? 'INTERNAL',
      body.details ?? {},
      Boolean(body.overridable),
      res.status,
    );
  }
  return body as T;
}

/**
 * 只读查询。成功后写进 IndexedDB —— 断网时这就是前台看到的最后画面。
 *
 * 失败时【不】自动回退到缓存：那会让人分不清看到的是实时还是快照。
 * 要不要用缓存由上层根据网络状态决定，并在界面上明确标出「显示的是 14:32 的数据」。
 */
export async function apiGet<T>(path: string, membershipId?: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { headers: await authHeaders(membershipId) });
  const out = await parse<T>(res);
  if (!res.headers.get('Cache-Control')?.includes('no-store')) {
    void cache(`${membershipId ?? activeMembershipId ?? '-'}::${path}`, out);
  }
  return out;
}

export async function apiGetCached<T>(
  path: string, membershipId?: string,
): Promise<{ value: T; at: number } | null> {
  return readCache<T>(`${membershipId ?? activeMembershipId ?? '-'}::${path}`);
}

export async function apiPost<T>(
  path: string,
  body: unknown,
  options?: { headers?: Record<string, string>; membershipId?: string },
): Promise<T> {
  const baseHeaders = await authHeaders(options?.membershipId);
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { ...baseHeaders, ...options?.headers },
    body: JSON.stringify(body ?? {}),
  });
  return parse<T>(res);
}


export interface CommandResult<T> {
  result: T;
  replayed: boolean;
  undoToken?: string;
}

/** 幂等键由客户端生成：网络差的门店重试时不会重复建单 */
export async function runCommand<T>(
  name: string,
  input: unknown,
  membershipId: string,
  idempotencyKey: string = crypto.randomUUID(),
): Promise<CommandResult<T>> {
  if (!commandGuardOnline) throw new ApiError('OFFLINE', {}, false, 0);
  const res = await fetch(`${API_BASE}/v1/commands/${name}`, {
    method: 'POST',
    headers: { ...(await authHeaders(membershipId)), 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify({ input }),
  });
  return parse<CommandResult<T>>(res);
}

export interface LocationMembership {
  membershipId: string;
  orgId: string;
  locationId: string;
  locationName: Record<string, string>;
  /** setup = 开店向导还没走完。进来先给他看向导，不是轮牌板 */
  locationStatus: string;
  roleKeys: string[];
  isBookable?: boolean;
}

export interface ClaimableStore {
  locationId: string;
  shopName: string;
  plan: string;
}

export interface LocationsResponse {
  locations: LocationMembership[];
  claimable: ClaimableStore | null;
}

/**
 * 门店选择器与待开通门店数据源。登录后的第一个调用。
 *
 * ⚠️ 该请求**不带** `X-Membership-Id`：调用它的目的正是确定应当使用哪一个
 * membership 或是否有待认领的已付费门店。服务端以 JWT 中的 user id 为准。
 */
export async function fetchLocationsAndClaimable(): Promise<LocationsResponse> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new ApiError('UNAUTHENTICATED', {}, false, 401);
  const res = await fetch(`${API_BASE}/v1/me/locations`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  const body = await parse<{ locations: LocationMembership[]; claimable?: ClaimableStore | null }>(res);
  return {
    locations: body.locations ?? [],
    claimable: body.claimable ?? null,
  };
}

export async function listLocations(): Promise<LocationMembership[]> {
  const res = await fetchLocationsAndClaimable();
  return res.locations;
}

/**
 * 当前门店下的操作上下文。选定门店后的第二个调用。
 *
 * ⚠️ **该接口不是权限边界。** 真正的判定在命令总线中，每条命令执行前
 * 重新查库。此处返回的 `permissions` 只用于决定「画不画那个按钮」——
 * 客户端篡改它不会获得任何多余能力，只会得到一个必然被服务端拒绝的按钮。
 *
 * 同时返回 `locale` 与 `timezone`：门店营业日的边界按门店时区计算，
 * 不得使用浏览器本地时区（跨时区连锁与旅行中的老板都会算错日期）。
 */
export interface MembershipContext {
  membershipId: string;
  orgId: string;
  locationId: string;
  locale: string;
  timezone: string;
  /** `HH:MM` 营业日翻页时刻。门店的「今天」由它决定，不是日历日（AUD-13）。 */
  businessDayCutoff: string;
  permissions: string[];
}

export async function fetchMembershipContext(membershipId: string): Promise<MembershipContext> {
  return apiGet<MembershipContext>('/v1/me/context', membershipId);
}

/**
 * 认领门店 —— 自助开户的最后一步（docs/12 §3 B）。
 *
 * ⚠️ 这是唯一一条**不带 X-Membership-Id** 的写请求：调用它的人这一刻
 * 还没有任何 membership，这条请求本身就是去造那一条。
 *
 * 身份边界不在这里，也不在浏览器里：后端拿的是 JWT 里的 user id，
 * 去数据库里比对 auth.users 的邮箱和当初付款那个邮箱。
 * 前端连一个可以传错的字段都没有。
 */
export async function claimLocation(): Promise<{
  membershipId: string; locationId: string; orgId: string;
}> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new ApiError('UNAUTHENTICATED', {}, false, 401);
  const res = await fetch(`${API_BASE}/v1/setup/claim`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    // 这条命令不要参数，但**空 body 也得是合法 JSON** —— 少了这一行，
    // 服务端的 JSON 解析器会抛 SyntaxError，前台看到的是 500
    body: '{}',
  });
  return parse(res);
}

/**
 * 忘记密码 —— 请求发送重置邮件。不需要 Authorization 与 X-Membership-Id。
 *
 * ⚠️ 走服务端而非前端直接调用 Supabase：限频、`redirect_to` 拼装与客服可查的
 * 尝试日志都必须由服务端掌握。
 *
 * ⚠️ **无论邮箱是否注册，服务端一律返回 200。** 前端不得据此推断账号是否存在，
 * 界面文案必须写成条件句（「如果该邮箱已注册…」）—— 否则该接口会退化为一个
 * 探测客户名单的入口。唯一需要单独呈现的是 429（限频），
 * 它只说明该 IP 或地址近期被频繁请求，不泄露账号信息。
 */
export async function requestPasswordReset(email: string): Promise<{ ok: boolean }> {
  const res = await fetch(`${API_BASE}/v1/auth/password/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  return parse(res);
}
