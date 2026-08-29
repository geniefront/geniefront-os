import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, runCommand } from '@/lib/api';
import { useSession } from '@/lib/session';

export interface PairingSessionResponse {
  sessionId: string;
  code: string;
  qrPayload: string;
  expiresAt: string;
  terminalType: 'customer-facing' | 'kiosk';
}

export interface PairingStatusResponse {
  status: 'pending' | 'paired' | 'expired';
  terminalType: string;
  pairedDeviceId: string | null;
}

export interface HardwareDevice {
  deviceId: string;
  label: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  state: 'online' | 'offline' | 'revoked';
  terminalType: 'customer-facing' | 'kiosk' | null;
  model: string | null;
  ipAddress: string | null;
  batteryLevel: number | null;
  wifiSignalDbm: number | null;
  appVersion: string | null;
  pendingCommandCount: number;
}

export function useCreatePairingSession() {
  const { membershipId } = useSession();
  return useMutation({
    mutationFn: async (terminalType: 'customer-facing' | 'kiosk' = 'kiosk') => {
      return apiPost<PairingSessionResponse>('/v1/desk/pairing/session', { terminalType }, {
        headers: { 'X-Membership-Id': membershipId! },
      });
    },
  });
}

export function usePairingStatus(code: string | null) {
  const { membershipId, status } = useSession();
  return useQuery({
    queryKey: ['desk', 'pairing-status', membershipId, code],
    queryFn: () => apiGet<PairingStatusResponse>(`/v1/desk/pairing/session/${code}/status`),
    enabled: status === 'ready' && membershipId !== null && Boolean(code),
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data?.status === 'paired' || data?.status === 'expired') {
        return false;
      }
      return 3000;
    },
  });
}

export function useHardwareDevicesQuery() {
  const { membershipId, status } = useSession();
  return useQuery({
    queryKey: ['desk', 'hardware-devices', membershipId],
    queryFn: () => apiGet<{ devices: HardwareDevice[] }>('/v1/desk/hardware/devices'),
    enabled: status === 'ready' && membershipId !== null,
  });
}

export function useRevokeDevice() {
  const { membershipId } = useSession();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (deviceId: string) => (await runCommand<{ deviceId: string }>('device.revokeToken', { deviceId }, membershipId!)).result,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['desk', 'hardware-devices'] }),
  });
}

export function useQueueDeviceCommand() {
  const { membershipId } = useSession();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { deviceId: string; kind: 'wake' | 'reset_home' }) =>
      (await runCommand<{ commandId: string; deviceId: string; status: 'pending' }>(
        'device.queueCommand', input, membershipId!,
      )).result,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['desk', 'hardware-devices'] }),
  });
}
