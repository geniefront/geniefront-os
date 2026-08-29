import type {
  ClaimPairingResponse,
  KioskHelloResponse,
  CheckInLookupResponse,
  QueueJoinResult,
  QueueStatusResponse,
  KioskRequiredFormsResponse,
  SubmitFormPayload,
  SubmitFormResult,
  DeviceHeartbeatResponse,
} from '../types';

declare const __API_BASE__: string;
export const API_BASE = typeof __API_BASE__ !== 'undefined' ? __API_BASE__ : 'http://localhost:3000';

const DEVICE_TOKEN_KEY = 'gf_kiosk_device_token';

export function getStoredDeviceToken(): string | null {
  try {
    return localStorage.getItem(DEVICE_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setStoredDeviceToken(token: string | null): void {
  try {
    if (token) {
      localStorage.setItem(DEVICE_TOKEN_KEY, token);
    } else {
      localStorage.removeItem(DEVICE_TOKEN_KEY);
    }
  } catch {
    // Ignore localStorage errors
  }
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public details?: unknown,
  ) {
    super(`API Error ${status}: ${code}`);
    this.name = 'ApiError';
  }
}

async function request<T>(
  path: string,
  options: RequestInit = {},
  onUnauthorized?: () => void,
): Promise<T> {
  const token = getStoredDeviceToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> | undefined),
  };

  if (token) {
    headers['x-device-token'] = token;
  }

  const url = `${API_BASE}${path}`;
  let res: Response;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 15_000);
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  try {
    res = await fetch(url, {
      ...options,
      headers,
      signal: controller.signal,
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
  } catch (err) {
    throw new ApiError(0, 'NETWORK_ERROR', err);
  } finally {
    window.clearTimeout(timeout);
  }

  if (res.status === 401) {
    if (onUnauthorized) onUnauthorized();
    setStoredDeviceToken(null);
    throw new ApiError(401, 'UNAUTHORIZED', { reason: 'device_token_invalid_or_revoked' });
  }

  let data: any;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (!res.ok) {
    throw new ApiError(res.status, data?.code || 'ERROR', data?.details);
  }

  return data as T;
}

export const api = {
  claimPairing: (code: string, label = 'iPad Kiosk Terminal') =>
    request<ClaimPairingResponse>('/v1/public/pairing/claim', {
      method: 'POST',
      body: JSON.stringify({ code, label }),
    }),

  hello: (onUnauthorized?: () => void) =>
    request<KioskHelloResponse>('/v1/kiosk/hello', { method: 'GET' }, onUnauthorized),

  heartbeat: (telemetry: { model?: string; batteryLevel?: number; wifiSignalDbm?: number; appVersion?: string }) =>
    request<DeviceHeartbeatResponse>('/v1/kiosk/heartbeat', {
      method: 'POST',
      body: JSON.stringify(telemetry),
    }),

  ackCommand: (commandId: string, status: 'acknowledged' | 'failed' = 'acknowledged') =>
    request<{ commandId: string; status: string }>(`/v1/kiosk/commands/${commandId}/ack`, {
      method: 'POST',
      body: JSON.stringify({ status }),
    }),

  lookupAppointments: (phone: string) =>
    request<CheckInLookupResponse>('/v1/kiosk/check-in/lookup', {
      method: 'POST',
      body: JSON.stringify({ phone }),
    }),

  checkIn: (appointmentId: string) =>
    request<QueueJoinResult>('/v1/kiosk/check-in', {
      method: 'POST',
      body: JSON.stringify({ appointmentId }),
    }),

  walkIn: (params: { name: string; phone?: string; email?: string; serviceId?: string; partySize?: number; idempotencyKey: string }) =>
    request<QueueJoinResult>('/v1/kiosk/walk-in', {
      method: 'POST',
      body: JSON.stringify(params),
    }),

  getQueueStatus: (queueId: string) =>
    request<QueueStatusResponse>(`/v1/kiosk/queue/${queueId}`, { method: 'GET' }),

  getRequiredForms: (params: { appointmentId?: string; queueId?: string }) => {
    const qs = new URLSearchParams();
    if (params.appointmentId) qs.set('appointmentId', params.appointmentId);
    if (params.queueId) qs.set('queueId', params.queueId);
    return request<KioskRequiredFormsResponse>(`/v1/kiosk/forms/required?${qs.toString()}`, {
      method: 'GET',
    });
  },

  submitForm: (payload: SubmitFormPayload) =>
    request<SubmitFormResult>('/v1/kiosk/forms/submit', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
};
