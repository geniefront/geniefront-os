import { z } from 'zod';

const locales = ['zh-Hans', 'en', 'ko', 'es', 'vi'] as const;
const text = z.object(Object.fromEntries(locales.map((locale) => [locale, z.string().min(1).max(1200)])) as Record<typeof locales[number], z.ZodString>);
const lines = z.object(Object.fromEntries(locales.map((locale) => [locale, z.array(z.string().min(1).max(500)).max(20)])) as Record<typeof locales[number], z.ZodArray<z.ZodString>>);
export const healthAiSummarySchema = z.object({
  riskLevel: z.enum(['low', 'moderate', 'high']),
  headline: text,
  keyAlerts: lines,
  avoidAreasList: lines,
  focusNotes: text,
  technicianAdvice: text,
});
export type HealthAiSummary = z.infer<typeof healthAiSummarySchema>;
