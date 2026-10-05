import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, runCommand } from '@/lib/api';
import { useAttemptKey } from '@/lib/idempotency';
import { useSession } from '@/lib/session';
import type {
  PackagesQueryResponse,
  CouponsQueryResponse,
  LoyaltyQueryResponse,
  GiftCardsQueryResponse,
  SavePackageTemplateInput,
  RedeemPackageInput,
  SaveCouponTemplateInput,
  VoidCouponInput,
  SaveLoyaltyRulesInput,
  AdjustLoyaltyPointsInput,
  AdjustGiftCardInput,
} from './types';

export const marketingKeys = {
  packages: (membershipId: string | null) => ['desk', 'packages', membershipId] as const,
  coupons: (membershipId: string | null) => ['desk', 'coupons', membershipId] as const,
  loyalty: (membershipId: string | null) => ['desk', 'loyalty', membershipId] as const,
  giftCards: (membershipId: string | null, q?: string) => ['desk', 'giftcards', membershipId, q ?? ''] as const,
};

export function usePackagesQuery() {
  const { membershipId, status } = useSession();
  return useQuery({
    queryKey: marketingKeys.packages(membershipId),
    queryFn: () => apiGet<PackagesQueryResponse>('/v1/desk/packages'),
    enabled: status === 'ready' && membershipId !== null,
  });
}

export function useCouponsQuery() {
  const { membershipId, status } = useSession();
  return useQuery({
    queryKey: marketingKeys.coupons(membershipId),
    queryFn: () => apiGet<CouponsQueryResponse>('/v1/desk/coupons'),
    enabled: status === 'ready' && membershipId !== null,
  });
}

export function useLoyaltyQuery() {
  const { membershipId, status } = useSession();
  return useQuery({
    queryKey: marketingKeys.loyalty(membershipId),
    queryFn: () => apiGet<LoyaltyQueryResponse>('/v1/desk/loyalty'),
    enabled: status === 'ready' && membershipId !== null,
  });
}

export function useGiftCardsQuery(q = '') {
  const { membershipId, status } = useSession();
  return useQuery({
    queryKey: marketingKeys.giftCards(membershipId, q),
    queryFn: () => apiGet<GiftCardsQueryResponse>(`/v1/desk/giftcards${q ? `?q=${encodeURIComponent(q)}` : ''}`),
    enabled: status === 'ready' && membershipId !== null,
  });
}

// ── Mutations ──

export function useSavePackageTemplate() {
  const { membershipId } = useSession();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: SavePackageTemplateInput) => {
      const res = await runCommand<{ templateId: string }>('package.saveTemplate', input, membershipId!);
      return res.result;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['desk', 'packages'] });
    },
  });
}

export function useRedeemPackage() {
  const { membershipId } = useSession();
  const queryClient = useQueryClient();
  const attempt = useAttemptKey();
  return useMutation({
    mutationFn: async (input: RedeemPackageInput) => {
      const res = await runCommand<{ customerPackageId: string; remainingUnits: number }>('package.redeem', input, membershipId!, attempt.take([membershipId, input]));
      return res.result;
    },
    onSuccess: (_, input) => {
      attempt.settle([membershipId, input]);
      queryClient.invalidateQueries({ queryKey: ['desk', 'packages'] });
    },
  });
}

export function useSaveCouponTemplate() {
  const { membershipId } = useSession();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: SaveCouponTemplateInput) => {
      const res = await runCommand<{ couponId: string }>('coupon.saveTemplate', input, membershipId!);
      return res.result;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['desk', 'coupons'] });
    },
  });
}

export function useVoidCoupon() {
  const { membershipId } = useSession();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: VoidCouponInput) => {
      const res = await runCommand<{ couponId: string; active: boolean }>('coupon.void', input, membershipId!);
      return res.result;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['desk', 'coupons'] });
    },
  });
}

export function useSaveLoyaltyRules() {
  const { membershipId } = useSession();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: SaveLoyaltyRulesInput) => {
      const res = await runCommand<{ locationId: string }>('loyalty.saveRules', input, membershipId!);
      return res.result;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['desk', 'loyalty'] });
    },
  });
}

export function useAdjustLoyaltyPoints() {
  const { membershipId } = useSession();
  const queryClient = useQueryClient();
  const attempt = useAttemptKey();
  return useMutation({
    mutationFn: async (input: AdjustLoyaltyPointsInput) => {
      const res = await runCommand<{ customerId: string; newPoints: number }>('loyalty.adjustPoints', input, membershipId!, attempt.take([membershipId, input]));
      return res.result;
    },
    onSuccess: (_, input) => {
      attempt.settle([membershipId, input]);
      queryClient.invalidateQueries({ queryKey: ['desk', 'loyalty'] });
    },
  });
}

export function useAdjustGiftCard() {
  const { membershipId } = useSession();
  const queryClient = useQueryClient();
  const attempt = useAttemptKey();
  return useMutation({
    mutationFn: async (input: AdjustGiftCardInput) => {
      const res = await runCommand<{ giftCardId: string; balanceCents: number }>(
        'giftcard.adjust',
        input,
        membershipId!,
        attempt.take([membershipId, input]),
      );
      return res.result;
    },
    onSuccess: (_, input) => {
      attempt.settle([membershipId, input]);
      queryClient.invalidateQueries({ queryKey: ['desk', 'giftcards'] });
    },
  });
}
