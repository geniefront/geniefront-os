import { PLAN_PRICES_CENTS, PLAN_QUOTAS, PLANS, TRIAL_DAYS, type Plan } from '@gf/payroll';

export type MarketingPlan = 'voice_booking' | 'essential' | 'growth';

export const MARKETING_PLANS = ['voice_booking', 'essential', 'growth'] as const;

export const MARKETING_PLAN_PRICES_CENTS: Record<MarketingPlan, number> = {
  voice_booking: 9900,
  essential: PLAN_PRICES_CENTS.essential,
  growth: PLAN_PRICES_CENTS.growth,
};

export const MARKETING_PLAN_QUOTAS: Record<MarketingPlan, { credits: number; voiceMinutes: number }> = {
  voice_booking: { credits: 0, voiceMinutes: 200 },
  essential: PLAN_QUOTAS.essential,
  growth: PLAN_QUOTAS.growth,
};

export type { Plan };
export { PLANS, PLAN_PRICES_CENTS, PLAN_QUOTAS, TRIAL_DAYS };

export const PLAN_COPY: Record<MarketingPlan, { name: string; summary: string }> = {
  voice_booking: {
    name: 'AI Voice Booking',
    summary: 'Dedicated automated AI voice booking with 200 minutes, unlimited SMS and email reminders, unlimited staff calendars, and free website creation.',
  },
  essential: {
    name: 'Essential',
    summary: 'The complete shop OS, free website creation, and AI customer-service setup. Includes 500 AI credits and 60 AI voice minutes each month.',
  },
  growth: {
    name: 'Growth',
    summary: 'The same complete shop OS with 1,200 AI credits, 500 AI voice minutes, and VIP professional 1-to-1 technical support.',
  },
};
