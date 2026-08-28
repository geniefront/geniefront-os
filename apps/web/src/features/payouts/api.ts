import { useQuery } from '@tanstack/react-query';
import { apiGet } from '@/lib/api';
import { useSession } from '@/lib/session';
import type {
  EarningsEstimatesResponse,
  EarningsEstimateItem,
  ClawbacksResponse,
} from './types';

export const payoutKeys = {
  earningsEstimates: (membershipId: string | null) =>
    ['desk', 'earnings', 'estimates', membershipId] as const,
  earningsEstimate: (membershipId: string | null, targetStaffId: string | null) =>
    ['desk', 'earnings', 'estimate', membershipId, targetStaffId] as const,
  clawbacks: (membershipId: string | null) =>
    ['desk', 'payouts', 'clawbacks', membershipId] as const,
};

export function useEarningsEstimatesQuery() {
  const { membershipId, status } = useSession();
  return useQuery({
    queryKey: payoutKeys.earningsEstimates(membershipId),
    queryFn: () => apiGet<EarningsEstimatesResponse>('/v1/desk/earnings/estimates'),
    enabled: status === 'ready' && membershipId !== null,
  });
}

export function useEarningsEstimateQuery(targetStaffId: string | null) {
  const { membershipId, status } = useSession();
  return useQuery({
    queryKey: payoutKeys.earningsEstimate(membershipId, targetStaffId),
    queryFn: () =>
      apiGet<{ estimate: EarningsEstimateItem }>(`/v1/desk/earnings/estimates/${targetStaffId}`),
    enabled: status === 'ready' && membershipId !== null && Boolean(targetStaffId),
  });
}

export function useClawbacksQuery() {
  const { membershipId, status } = useSession();
  return useQuery({
    queryKey: payoutKeys.clawbacks(membershipId),
    queryFn: () => apiGet<ClawbacksResponse>('/v1/desk/payouts/clawbacks'),
    enabled: status === 'ready' && membershipId !== null,
  });
}
