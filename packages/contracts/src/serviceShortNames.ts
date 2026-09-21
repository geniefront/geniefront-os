import { z } from 'zod';
export const SERVICE_SHORT_NAME_LOCALES = ['en', 'zh-Hans', 'zh-Hant', 'ko', 'vi', 'es'] as const;
export type ServiceShortNameLocale = typeof SERVICE_SHORT_NAME_LOCALES[number];
// Two characters is a writing goal, not a destructive truncation rule.
const shortName = z.string().trim().max(24).refine(s => [...s].length <= 12 && !/[\r\n\t|｜]/u.test(s), 'Use at most 12 characters without line breaks or separators');
export const serviceShortNamesSchema = z.object({
  en: shortName.optional(), 'zh-Hans': shortName.optional(), 'zh-Hant': shortName.optional(),
  ko: shortName.optional(), vi: shortName.optional(), es: shortName.optional(),
}).strict();
export type ServiceShortNames = z.infer<typeof serviceShortNamesSchema>;
export function missingServiceShortNames(names: ServiceShortNames): ServiceShortNameLocale[] {
  return SERVICE_SHORT_NAME_LOCALES.filter(l => !names[l]?.trim());
}
