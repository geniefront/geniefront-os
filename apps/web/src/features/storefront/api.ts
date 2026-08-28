import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPost, runCommand } from "@/lib/api";
import { useSession } from "@/lib/session";
import type { BlueprintsResponse, SaveStorefrontBriefInput } from "./types";

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
      apiGet<{
        shopName: string;
        slogan: string;
        brief: {
          id: string;
          status: string;
          voice: string | null;
          brandPrimary: string | null;
          brandAccent: string | null;
          painPoints: string[];
          sections: string[];
          usp: string | null;
          tone: "modern" | "luxury" | "zen" | "warm" | null;
          currentSiteUrl: string | null;
          referenceSites: string[];
        } | null;
      }>("/v1/desk/storefront/brief"),
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

export interface StorefrontRevision {
  id: string;
  time: string;
  text: string;
  status: string;
}

export function useStorefrontRevisionsQuery() {
  const { membershipId, status } = useSession();
  return useQuery({
    queryKey: ["desk", "storefront-revisions", membershipId],
    queryFn: () => apiGet<{ revisions: StorefrontRevision[] }>("/v1/desk/storefront/revisions"),
    enabled: status === "ready" && membershipId !== null,
  });
}

export function useAddStorefrontRevisionMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ text }: { text: string }) => {
      const res = await apiPost<{ success: boolean; revision: StorefrontRevision; revisions: StorefrontRevision[] }>(
        "/v1/desk/storefront/revisions",
        { text },
      );
      return res;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["desk", "storefront-revisions"] });
    },
  });
}