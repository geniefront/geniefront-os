import { PLAN_PRICES_CENTS, PLAN_QUOTAS, PLANS, TRIAL_DAYS, type Plan } from '@gf/payroll';

export type { Plan };
export { PLANS, PLAN_PRICES_CENTS, PLAN_QUOTAS, TRIAL_DAYS };

export const PLAN_COPY: Record<Plan, { name: string; summary: string }> = {
  essential: {
    name: 'Essential',
    summary: 'The complete shop OS, free website creation, and AI customer-service setup. Includes 500 AI credits and 60 AI voice minutes each month.',
  },
  growth: {
    name: 'Growth',
    summary: 'The same complete shop OS with 1,200 AI credits, 500 AI voice minutes, and VIP professional 1-to-1 technical support.',
  },
};
