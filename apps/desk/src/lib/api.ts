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

async function authHeaders(membershipId?: string): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new ApiError('UNAUTHENTICATED', {}, false, 401);
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    ...(membershipId ? { 'X-Membership-Id': membershipId } : {}),
  };
}

async function parse<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
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
  void cache(`${membershipId ?? '-'}::${path}`, out);
  return out;
}

export async function apiGetCached<T>(
  path: string, membershipId?: string,
): Promise<{ value: T; at: number } | null> {
  return readCache<T>(`${membershipId ?? '-'}::${path}`);
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
  roleKeys: string[];
}
