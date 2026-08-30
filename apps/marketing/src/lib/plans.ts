import { PLAN_PRICES_CENTS, PLAN_QUOTAS, PLANS, TRIAL_DAYS, type Plan } from '@gf/payroll';

export type { Plan };
export { PLANS, PLAN_PRICES_CENTS, PLAN_QUOTAS, TRIAL_DAYS };

export const PLAN_COPY: Record<Plan, { name: string; summary: string }> = {
  essential: {
    name: 'Essential',
    summary: 'Full shop OS for a single location. 500 AI credits and 60 AI voice minutes each month.',
  },
  growth: {
    name: 'Growth',
    summary: 'Same shop OS with more AI capacity. 1200 AI credits and 500 AI voice minutes each month.',
  },
};
