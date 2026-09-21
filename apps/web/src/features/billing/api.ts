import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPost, runCommand } from "@/lib/api";
import { useSession } from "@/lib/session";
import { isRelativeAppPath, PORTAL_RETURN_PATH } from "./display";
import type {
  BillingResponse,
  RedeemCodeResponse,
  SetAutoTopupInput,
  BillingInvoicesResponse,
  TaxProfile,
  SaveTaxProfileInput,
  QuotaUnit,
  TopupResponse,
} from "./types";

export const billingKeys = {
  detail: (membershipId: string | null) => ["desk", "billing", membershipId] as const,
  invoices: (membershipId: string | null) => ["desk", "billing", "invoices", membershipId] as const,
  taxProfile: (membershipId: string | null) => ["desk", "billing", "taxProfile", membershipId] as const,
};

export function useBillingQuery() {
  const { membershipId, status } = useSession();
  return useQuery({
    queryKey: billingKeys.detail(membershipId),
    queryFn: () => apiGet<BillingResponse>("/v1/desk/billing"),
    enabled: status === "ready" && membershipId !== null,
    staleTime: 0, refetchOnWindowFocus: 'always', refetchInterval: 30_000,
  });
}

export function useInvoicesQuery() {
  const { membershipId, status } = useSession();
  return useQuery({
    queryKey: billingKeys.invoices(membershipId),
    queryFn: () => apiGet<BillingInvoicesResponse>("/v1/desk/billing/invoices"),
    enabled: status === "ready" && membershipId !== null,
  });
}

export function useTaxProfileQuery() {
  const { membershipId, status } = useSession();
  return useQuery({
    queryKey: billingKeys.taxProfile(membershipId),
    queryFn: () => apiGet<{ taxProfile: TaxProfile | null }>("/v1/desk/billing/tax-profile"),
    enabled: status === "ready" && membershipId !== null,
  });
}

export function useSetAutoTopup() {
  const { membershipId } = useSession();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: SetAutoTopupInput) => {
      const res = await runCommand<{ enabled: boolean; thresholdUnits: number }>(
        "billing.setAutoTopup",
        input,
        membershipId!,
      );
      return res;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["desk", "billing"] });
    },
  });
}

export function useSaveTaxProfileMutation() {
  const { membershipId } = useSession();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: SaveTaxProfileInput) => {
      const res = await runCommand<{ saved: boolean }>(
        "billing.saveTaxProfile",
        input,
        membershipId!,
      );
      return res;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["desk", "billing", "taxProfile"] });
    },
  });
}

export function useCreateBillingPortalSession() {
  const { membershipId } = useSession();

  return useMutation({
    mutationFn: async (returnPath?: string | void) => {
      const candidate = typeof returnPath === 'string' ? returnPath : undefined;
      const path = isRelativeAppPath(candidate) ? candidate : PORTAL_RETURN_PATH;
      const res = await apiPost<{ url: string | null }>(
        "/v1/billing/portal-session",
        { returnUrl: path },
        { headers: { "X-Membership-Id": membershipId! } },
      );
      return res;
    },
  });
}

export function useCreatePaymentMethodSession() {
  const { membershipId } = useSession();

  return useMutation({
    mutationFn: async (returnPath?: string | void) => {
      const candidate = typeof returnPath === 'string' ? returnPath : undefined;
      const path = isRelativeAppPath(candidate) ? candidate : PORTAL_RETURN_PATH;
      return apiPost<{ url: string | null; sessionId?: string }>(
        "/v1/billing/payment-method",
        { successUrl: path, cancelUrl: path },
        { headers: { "X-Membership-Id": membershipId! } },
      );
    },
  });
}

/**
 * 兑换一张订阅码 / 额度包码（迁移 0120）。
 *
 * ## 为什么走 REST 路由而不是 `runCommand`
 *
 * 那条路由在命令之前先过**限频**（按 IP 与门店各一条）。码是「捡到就能用」
 * 的凭证，没有限频的兑换接口本身就是一个可以无限次试的口子。
 * 命令总线没有限频这一层，所以这一步必须在路由上（同 `/v1/billing/topup`）。
 *
 * ⚠️ 兑换成功后要把**整个** billing 查询失效，不只是余额：一张订阅码同时
 * 改了到期日、状态和套餐内额度档位，只刷余额的话界面会显示一个
 * 「已到期但有额度」的自相矛盾状态。
 */
export function useRedeemLicenseCode() {
  const { membershipId } = useSession();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (code: string) => apiPost<RedeemCodeResponse>(
      "/v1/desk/billing/redeem-code",
      { code },
      { headers: { "X-Membership-Id": membershipId! } },
    ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["desk", "billing"] });
    },
  });
}

export function useCreateTopup() {
  const { membershipId } = useSession();

  return useMutation({
    mutationFn: async (unit: QuotaUnit) => {
      return apiPost<TopupResponse>(
        "/v1/billing/topup",
        { unit, successUrl: PORTAL_RETURN_PATH, cancelUrl: PORTAL_RETURN_PATH },
        { headers: { "X-Membership-Id": membershipId! } },
      );
    },
  });
}

export function useConfirmOwnershipPayment() {
  const { membershipId } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => runCommand('billing.confirmOwnershipPayment', { confirmed: true }, membershipId!),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['desk', 'billing'] }); },
  });
}
