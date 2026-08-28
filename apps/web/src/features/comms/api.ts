import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet, runCommand } from "@/lib/api";
import { useSession } from "@/lib/session";
import type {
  CallsQueryResponse,
  CallDraftsQueryResponse,
  InboundSmsQueryResponse,
  DraftDismissReason,
} from "./types";

export const commsKeys = {
  calls: (membershipId: string | null, days?: number) =>
    ["desk", "calls", membershipId, days ?? 7] as const,
  drafts: (membershipId: string | null, status?: string) =>
    ["desk", "call-drafts", membershipId, status ?? "pending"] as const,
  sms: (membershipId: string | null, days?: number) =>
    ["desk", "sms-inbound", membershipId, days ?? 14] as const,
};

export function useCallsQuery(days = 7) {
  const { membershipId, status } = useSession();
  return useQuery({
    queryKey: commsKeys.calls(membershipId, days),
    queryFn: () => apiGet<CallsQueryResponse>("/v1/desk/calls?days=" + days),
    enabled: status === "ready" && membershipId !== null,
    refetchInterval: 20_000,
  });
}

export function useCallDraftsQuery(draftStatus = "pending") {
  const { membershipId, status } = useSession();
  return useQuery({
    queryKey: commsKeys.drafts(membershipId, draftStatus),
    queryFn: () => apiGet<CallDraftsQueryResponse>("/v1/desk/call-drafts?status=" + draftStatus),
    enabled: status === "ready" && membershipId !== null,
    refetchInterval: 10_000,
  });
}

export function useInboundSmsQuery(days = 14) {
  const { membershipId, status } = useSession();
  return useQuery({
    queryKey: commsKeys.sms(membershipId, days),
    queryFn: () => apiGet<InboundSmsQueryResponse>("/v1/desk/sms-inbound?days=" + days),
    enabled: status === "ready" && membershipId !== null,
    refetchInterval: 15_000,
  });
}

export function useDismissCallDraft() {
  const { membershipId } = useSession();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      draftId,
      dismissReason,
      notes,
    }: {
      draftId: string;
      dismissReason: DraftDismissReason;
      notes?: string;
    }) => {
      const res = await runCommand<{ draftId: string; status: string }>(
        "call.reviewDraft",
        { draftId, decision: "dismissed", action: "dismiss", dismissReason, note: notes, notes },
        membershipId!,
      );
      return res;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["desk", "call-drafts"] });
    },
  });
}

export function useSendDirectSms() {
  const { membershipId } = useSession();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: import('./types').SendDirectSmsInput) => {
      const res = await runCommand<{
        smsId: string;
        toE164: string;
        segments: number;
        encoding: string;
        status: string;
        suppressed: boolean;
      }>(
        "sms.sendDirect",
        input,
        membershipId!,
      );
      return res.result;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["desk", "sms-inbound"] });
    },
  });
}