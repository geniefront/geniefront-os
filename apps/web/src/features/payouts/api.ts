import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, runCommand } from '@/lib/api';
import { useSession } from '@/lib/session';
import type {
  MerchantBalanceResponse,
  BankPayoutBatchesResponse,
  PayrollBatchesResponse,
  PayrollBatchItem,
  ClawbacksResponse,
} from './types';

export const payoutKeys = {
  merchantBalance: (membershipId: string | null) =>
    ['desk', 'payouts', 'balance', membershipId] as const,
  bankBatches: (membershipId: string | null) =>
    ['desk', 'payouts', 'bankBatches', membershipId] as const,
  payrollBatches: (membershipId: string | null) =>
    ['desk', 'payroll', 'batches', membershipId] as const,
  payrollStub: (membershipId: string | null, targetStaffId: string | null) =>
    ['desk', 'payroll', 'stub', membershipId, targetStaffId] as const,
  clawbacks: (membershipId: string | null) =>
    ['desk', 'payouts', 'clawbacks', membershipId] as const,
};

export function useMerchantBalanceQuery() {
  const { membershipId, status } = useSession();
  return useQuery({
    queryKey: payoutKeys.merchantBalance(membershipId),
    queryFn: () => apiGet<MerchantBalanceResponse>('/v1/desk/payouts/merchant-balance'),
    enabled: status === 'ready' && membershipId !== null,
  });
}

export function useBankPayoutBatchesQuery() {
  const { membershipId, status } = useSession();
  return useQuery({
    queryKey: payoutKeys.bankBatches(membershipId),
    queryFn: () => apiGet<BankPayoutBatchesResponse>('/v1/desk/payouts/bank-batches'),
    enabled: status === 'ready' && membershipId !== null,
  });
}

export function usePayrollBatchesQuery() {
  const { membershipId, status } = useSession();
  return useQuery({
    queryKey: payoutKeys.payrollBatches(membershipId),
    queryFn: () => apiGet<PayrollBatchesResponse>('/v1/desk/payroll/batches'),
    enabled: status === 'ready' && membershipId !== null,
  });
}

export function usePayrollStubQuery(targetStaffId: string | null) {
  const { membershipId, status } = useSession();
  return useQuery({
    queryKey: payoutKeys.payrollStub(membershipId, targetStaffId),
    queryFn: () =>
      apiGet<{ stub: PayrollBatchItem }>(`/v1/desk/payroll/stubs/${targetStaffId}`),
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
