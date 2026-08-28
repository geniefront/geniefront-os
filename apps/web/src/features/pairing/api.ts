import { useMutation, useQuery } from '@tanstack/react-query';
import { apiGet, apiPost } from '@/lib/api';
import { useSession } from '@/lib/session';

export interface PairingSessionResponse {
  sessionId: string;
  code: string;
  qrSvg: string;
  expiresAt: string;
}

export interface PairingStatusResponse {
  code: string;
  status: 'pending' | 'claimed' | 'expired';
  deviceId: string | null;
}

export function useCreatePairingSession() {
  const { membershipId } = useSession();
  return useMutation({
    mutationFn: async () => {
      return apiPost<PairingSessionResponse>('/v1/desk/pairing/session', {}, {
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
      if (data?.status === 'claimed' || data?.status === 'expired') {
        return false;
      }
      return 3000;
    },
  });
}
