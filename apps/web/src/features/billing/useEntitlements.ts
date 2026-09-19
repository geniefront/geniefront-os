import { useQuery } from '@tanstack/react-query';
import { useSession } from '@/lib/session';
import { apiGet } from '@/lib/api';
export function useEntitlements() {
  const { membershipId, status } = useSession();
  return useQuery({ queryKey: ['entitlements', membershipId],
    queryFn: () => apiGet<{ plan: string }>('/v1/desk/entitlements'),
    enabled: status === 'ready' && Boolean(membershipId),
    staleTime: 0, refetchOnWindowFocus: 'always', refetchInterval: 30_000,
  });
}
