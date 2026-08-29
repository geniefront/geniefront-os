import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPost, runCommand } from "@/lib/api";
import { useSession } from "@/lib/session";
import type { BlueprintsResponse, SaveStorefrontBriefInput, StorefrontBriefResponse, StorefrontDraftContent, StorefrontRevision } from "./types";

export const storefrontKeys = {
  blueprints: (membershipId: string | null) => ["desk", "blueprints", membershipId] as const,
};

export function useBlueprintsQuery() {
  const { membershipId, status } = useSession();
  return useQuery({
    queryKey: storefrontKeys.blueprints(membershipId),
    queryFn: () => apiGet<BlueprintsResponse>("/v1/desk/blueprints"),
    enabled: status === "ready" && membershipId !== null,
  });
}

export function useStorefrontBriefQuery() {
  const { membershipId, status } = useSession();
  return useQuery({
    queryKey: ["desk", "storefront-brief", membershipId],
    queryFn: () =>
      apiGet<StorefrontBriefResponse>("/v1/desk/storefront/brief"),
    enabled: status === "ready" && membershipId !== null,
  });
}

export function useSaveStorefrontDraft() {
  const { membershipId } = useSession();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: SaveStorefrontBriefInput) => {
      const res = await runCommand<{ briefId: string; status: string }>(
        "storefront.saveDraft",
        input,
        membershipId!,
      );
      return res;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["desk", "blueprints"] });
      queryClient.invalidateQueries({ queryKey: ["desk", "storefront-brief"] });
    },
  });
}

function useStorefrontCommand<TInput extends Record<string, unknown>, TResult>(name: string) {
  const { membershipId } = useSession();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: TInput) => (await runCommand<TResult>(name, input, membershipId!)).result,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["desk", "storefront-brief"] });
    },
  });
}

export const useSubmitStorefrontBrief = () => useStorefrontCommand<Record<string, never>, { briefId: string; status: string }>('storefront.submit');
export const useWithdrawStorefrontBrief = () => useStorefrontCommand<Record<string, never>, { briefId: string; status: string }>('storefront.withdraw');
export const useChooseStorefrontDraft = () => useStorefrontCommand<{ draftId: string }, { briefId: string; draftId: string; status: string }>('storefront.chooseDraft');
export const useRequestStorefrontLaunch = () => useStorefrontCommand<Record<string, never>, { briefId: string; status: string; launchRequestedAt: string }>('storefront.requestLaunch');

export function useStorefrontRevisionsQuery() {
  const { membershipId, status } = useSession();
  return useQuery({
    queryKey: ['desk', 'storefront-revisions', membershipId],
    queryFn: () => apiGet<{ revisions: StorefrontRevision[] }>('/v1/desk/storefront/revisions'),
    enabled: status === 'ready' && membershipId !== null,
  });
}

export function useAddStorefrontRevisionMutation() {
  const { membershipId } = useSession();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { text: string }) => (await runCommand<{
      revisionId: string; status: 'submitted'; createdAt: string;
    }>('storefront.addRevision', input, membershipId!)).result,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['desk', 'storefront-revisions'] }),
  });
}

export function useGenerateStorefrontDrafts() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (briefId: string) => apiPost<{ briefId: string; status: string; drafts: Array<{ variant: number; content: StorefrontDraftContent }> }>(`/v1/storefront/${briefId}/generate`, {}),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["desk", "storefront-brief"] }),
  });
}
