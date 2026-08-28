import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet, runCommand } from "@/lib/api";
import { useSession } from "@/lib/session";
import type { PayrollPlansQueryResponse, SavePayrollPlanInput } from "./types";

export const payrollKeys = {
  plans: (membershipId: string | null) => ["desk", "payroll", "plans", membershipId] as const,
};

export function usePayrollPlansQuery() {
  const { membershipId, status } = useSession();
  return useQuery({
    queryKey: payrollKeys.plans(membershipId),
    queryFn: () => apiGet<PayrollPlansQueryResponse>("/v1/desk/payroll/plans"),
    enabled: status === "ready" && membershipId !== null,
  });
}

export function useSavePayrollPlan() {
  const { membershipId } = useSession();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: SavePayrollPlanInput) => {
      const res = await runCommand<{ planId: string; version: number }>(
        "payroll.savePlan",
        input,
        membershipId!,
      );
      return res;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["desk", "payroll"] });
    },
  });
}