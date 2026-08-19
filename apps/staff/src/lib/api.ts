/**
 * API 客户端。写操作一律走 /v1/commands/:name（宪法第 1 条）。
 *
 * ⚠️ 和前台端不同：这里**没有**任何缓存与重放。
 * 技师端断网时的正确行为是明确告诉人「现在连不上」，
 * 而不是把动作攒起来晚点发（宪法第 18 条，理由见 public/sw.js）。
 */
import { supabase } from './supabase';

declare const __API_BASE__: string;
export const API_BASE = __API_BASE__;

export class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly details: Record<string, unknown>,
    readonly status: number,
  ) {
    super(code);
    this.name = 'ApiError';
  }
}

/**
 * 上机会话令牌（sql/0031）。
 *
 * 技师有两种登录方式，服务端认的是两种不同的东西：
 *   · 用邮箱登录 → Supabase 的 Bearer
 *   · **上机码 / 手机验证码** → 我们自己的会话令牌（`X-Staff-Token`）
 *
 * 后一种人**没有 Supabase 账号**，所以这里不能只认 Bearer。
 */
const LS_TOKEN = 'gf.staff.token';

export const getStaffToken = (): string | null => localStorage.getItem(LS_TOKEN);

export function setStaffToken(token: string | null): void {
  if (token) localStorage.setItem(LS_TOKEN, token);
  else localStorage.removeItem(LS_TOKEN);
}

async function headers(membershipId?: string): Promise<Record<string, string>> {
  const staffToken = getStaffToken();
  if (staffToken) {
    /**
     * ⚠️ 带会话令牌时**不发** X-Membership-Id：那是客户端自报的，
     * 而令牌里的 membership 是数据库给的。两个同时发等于给了服务端
     * 一个「听谁的」的选择题，而这种选择题迟早会选错。
     */
    return { 'X-Staff-Token': staffToken, 'Content-Type': 'application/json' };
  }

  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new ApiError('UNAUTHENTICATED', {}, 401);
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    ...(membershipId ? { 'X-Membership-Id': membershipId } : {}),
  };
}

/** 上机之后「我是谁」。技师端启动时先问这一句 */
export interface StaffMe {
  membershipId: string;
  locationId: string;
  displayName: string;
  locale: string;
  permissions: string[];
}

export interface IssuedSession {
  token: string; expiresAt: string;
  membershipId: string; locationId: string;
  shopName: string; displayName: string;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return parse<T>(res);
}

/** ① 老板念的 6 位上机码。**不依赖短信** —— 这是主路 */
export const claimByCode = (code: string, deviceLabel?: string): Promise<IssuedSession> =>
  post('/v1/auth/staff/claim-code', { code, deviceLabel });

/** ② 手机验证码：发码 */
export const phoneStart = (phone: string): Promise<{ ok: boolean }> =>
  post('/v1/auth/phone/start', { phone });

/**
 * ② 手机验证码：验码换会话。
 *
 * 一个技师在两家店上班时返回 `needsLocation` + 店铺列表，
 * 让他点一家再调一次（和多店老板的选店器是同一件事）。
 */
export const phoneVerify = (
  phone: string, code: string, locationId?: string, deviceLabel?: string,
): Promise<IssuedSession | {
  needsLocation: true;
  locations: Array<{ membershipId: string; locationId: string; shopName: string; displayName: string }>;
}> => post('/v1/auth/phone/verify', { phone, code, locationId, deviceLabel });

export const staffMe = (): Promise<StaffMe> => apiGet<StaffMe>('/v1/auth/staff/me');

async function parse<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(body.code ?? 'INTERNAL', body.details ?? {}, res.status);
  return body as T;
}

export async function apiGet<T>(path: string, membershipId?: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { headers: await headers(membershipId) });
  return parse<T>(res);
}

export interface CommandResult<T> { result: T; replayed: boolean; undoToken?: string }

export async function runCommand<T>(
  name: string,
  input: unknown,
  membershipId: string,
  idempotencyKey: string = crypto.randomUUID(),
): Promise<CommandResult<T>> {
  const res = await fetch(`${API_BASE}/v1/commands/${name}`, {
    method: 'POST',
    headers: { ...(await headers(membershipId)), 'Idempotency-Key': idempotencyKey },
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
