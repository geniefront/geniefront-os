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

async function headers(membershipId?: string): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new ApiError('UNAUTHENTICATED', {}, 401);
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    ...(membershipId ? { 'X-Membership-Id': membershipId } : {}),
  };
}

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
