/**
 * Kiosk 的 API 客户端。
 *
 * 和前台/技师端最大的不同：**没有登录**。身份是一个设备令牌，
 * 存在 localStorage 里，配一次用很久。
 *
 * ⚠️ 令牌是这台 iPad 的全部身份。它进不了别的地方（权限只有取号和交表），
 * 但拿到它的人能替这家店取号 —— 所以前台看到 iPad 丢了要**立刻吊销**。
 */

declare const __API_BASE__: string;
export const API_BASE = __API_BASE__;

const LS_TOKEN = 'gf.kiosk.deviceToken';

export const getToken = (): string | null => localStorage.getItem(LS_TOKEN);
export const setToken = (v: string): void => localStorage.setItem(LS_TOKEN, v.trim());
export const clearToken = (): void => localStorage.removeItem(LS_TOKEN);

export class KioskError extends Error {
  constructor(readonly code: string, readonly status: number, readonly details: Record<string, unknown> = {}) {
    super(code);
    this.name = 'KioskError';
  }
}

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const token = getToken();
  if (!token) throw new KioskError('NO_DEVICE_TOKEN', 401);

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Device-Token': token,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new KioskError(json.code ?? 'INTERNAL', res.status, json.details ?? {});
  return json as T;
}

export const apiGet = <T>(path: string) => call<T>('GET', path);
export const apiPost = <T>(path: string, body?: unknown) => call<T>('POST', path, body);

// ── 返回类型 ────────────────────────────────────────────────────────────────

export interface Hello {
  deviceLabel: string;
  locationName: Record<string, string>;
  timezone: string;
  businessDate: string;
  services: Array<{ id: string; name: Record<string, string>; durationMin: number }>;
}

export interface LookupResult {
  businessDate: string;
  matches: Array<{
    appointmentId: string;
    /** 只有打码的名字 —— 完整姓名要等他点了「是我」才给（见服务端注释） */
    maskedName: string;
    startsAt: string;
    alreadyQueued: boolean;
  }>;
}

export interface QueueTicket {
  queueId: string;
  ticketNumber: number;
  aheadCount: number;
  quotedWaitMin: number | null;
  businessDate: string;
}

export interface FormQuestion {
  id: string;
  type: 'bool' | 'text' | 'choice' | 'multi';
  label: Record<string, string>;
  options?: Array<{ value: string; label: Record<string, string> }>;
  required?: boolean;
}

export interface RequiredForm {
  templateId: string;
  key: string;
  version: number;
  title: Record<string, string>;
  questions: FormQuestion[];
  requiresSignature: boolean;
}
