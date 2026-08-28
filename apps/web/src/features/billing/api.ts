import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPost, runCommand } from "@/lib/api";
import { useSession } from "@/lib/session";
import type {
  BillingResponse,
  SetAutoTopupInput,
  BillingInvoicesResponse,
  TaxProfile,
  ChangePlanInput,
  BuyAddonInput,
  SaveTaxProfileInput,
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

export function useChangePlanMutation() {
  const { membershipId } = useSession();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: ChangePlanInput) => {
      const res = await runCommand<{
        success: boolean;
        targetPlan: string;
        billingCycle: string;
        proratedChargeCents: number;
      }>(
        "billing.changePlan",
        input,
        membershipId!,
      );
      return res;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["desk", "billing"] });
      void queryClient.invalidateQueries({ queryKey: ["desk", "billing", "invoices"] });
    },
  });
}

export function useBuyAddonMutation() {
  const { membershipId } = useSession();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: BuyAddonInput) => {
      const res = await runCommand<{
        success: boolean;
        addonType: string;
        priceCents: number;
        invoiceId: string;
        invoiceNumber: string;
      }>(
        "billing.buyAddon",
        input,
        membershipId!,
      );
      return res;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["desk", "billing"] });
      void queryClient.invalidateQueries({ queryKey: ["desk", "billing", "invoices"] });
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
    mutationFn: async (returnUrl?: string | void) => {
      const res = await apiPost<{ url: string }>(
        "/v1/billing/portal-session",
        { returnUrl: (typeof returnUrl === 'string' && returnUrl) ? returnUrl : window.location.href },
        { headers: { "X-Membership-Id": membershipId! } },
      );
      return res;
    },
  });
}