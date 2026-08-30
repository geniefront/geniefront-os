import { supabase } from './supabase';

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

let onUnauthenticated: (() => void) | null = null;
export function setUnauthenticatedHandler(handler: (() => void) | null): void {
  onUnauthenticated = handler;
}

async function authHeader(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) {
    onUnauthenticated?.();
    throw new ApiError('UNAUTHENTICATED', {}, 401);
  }
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

async function parse<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) onUnauthenticated?.();
    throw new ApiError(body.code ?? 'INTERNAL', body.details ?? {}, res.status);
  }
  return body as T;
}

export async function platformGet<T>(path: string): Promise<T> {
  const headers = await authHeader();
  const res = await fetch(`${API_BASE}${path}`, { headers });
  return parse<T>(res);
}

export async function platformSend<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers = await authHeader();
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return parse<T>(res);
}

export type OperatorSession = {
  operator: { userId: string; operatorId: string; role: string; email: string | null };
};

export type StoreRow = {
  locationId: string;
  orgId: string;
  locationName: string;
  organizationName: string;
  ownerEmail: string | null;
  locationStatus: string;
  timezone: string;
  plan: string | null;
  subscriptionStatus: string | null;
  trialEndsAt: string | null;
  createdAt: string;
  updatedAt: string;
};
