import { normalizePhoneE164 } from '@gf/contracts';
const PHONE_FIELDS = new Set(['phone', 'phoneE164', 'toE164', 'fromE164', 'storefrontE164', 'transferTargetE164', 'forwardPhoneNumber', 'repPhone', 'walkInPhone', 'emergencyPhone']);
/** Validate phone fields before sending mutations; backend schemas remain authoritative. */
export function normalizePhonePayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizePhonePayload);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (PHONE_FIELDS.has(key) && typeof item === 'string' && item.trim()) {
      const phone = normalizePhoneE164(item);
      if (!phone) throw new Error(key);
      return [key, phone];
    }
    return [key, normalizePhonePayload(item)];
  }));
}
