export type PlanKind = "commission" | "hourly" | "commission_vs_hourly" | "booth_rent";
export type CommissionBase = "net" | "gross";

export interface PayrollPlanConfig {
  version?: number;
  kind: PlanKind;
  rateBp: number;
  categoryRateBp?: Record<string, number>;
  retailRateBp?: number;
  hourlyRateCents?: number;
  base?: CommissionBase;
}

export interface StaffPayrollInfo {
  membershipId: string;
  name: string;
  plan: PayrollPlanConfig | null;
}

export interface PayrollPlansQueryResponse {
  defaultPlan: PayrollPlanConfig | null;
  staff: StaffPayrollInfo[];
  categories: Array<{ id: string; name: string }>;
}

export interface SavePayrollPlanInput {
  membershipId: string | null;
  kind: PlanKind;
  rateBp: number;
  categoryRateBp?: Record<string, number>;
  retailRateBp?: number;
  hourlyRateCents?: number;
  base?: CommissionBase;
}