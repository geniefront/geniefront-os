import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, runCommand } from '@/lib/api';
import { useSession } from '@/lib/session';
import type { StaffDirectoryItem, SaveStaffProfileInput, SetEmploymentInput } from './types';

export const staffKeys = {
  all: ['desk', 'staff'] as const,
  list: () => ['desk', 'staff', 'list'] as const,
};

export function useStaffListQuery() {
  const { membershipId, status } = useSession();
  return useQuery({
    queryKey: staffKeys.list(),
    queryFn: () => apiGet<{ staff: StaffDirectoryItem[] }>('/v1/desk/staff/list'),
    enabled: status === 'ready' && membershipId !== null,
  });
}

export function useSaveStaffProfile() {
  const { membershipId } = useSession();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: SaveStaffProfileInput) => {
      const res = await runCommand<{ membershipId: string; created?: boolean }>(
        'staff.saveProfile',
        input,
        membershipId!,
      );
      return res;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: staffKeys.all });
      queryClient.invalidateQueries({ queryKey: ['desk', 'rotation'] });
      queryClient.invalidateQueries({ queryKey: ['desk', 'payroll'] });
    },
  });
}

export function useSetEmploymentStatus() {
  const { membershipId } = useSession();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: SetEmploymentInput) => {
      const res = await runCommand<{ membershipId: string; status: string }>(
        'staff.setEmployment',
        input,
        membershipId!,
      );
      return res;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: staffKeys.all });
      queryClient.invalidateQueries({ queryKey: ['desk', 'rotation'] });
    },
  });
}
