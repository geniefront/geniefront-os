import { z } from "zod";
import { AppError, ERROR_CODES, VoiceBookingItems, selectionGuests } from "@gf/contracts";
// Tools may omit the redundant anchor when the covered guests are explicit.
// Keep the command schema strict; only normalize this unambiguous API shape.
export const voiceItems = z.preprocess((raw) => Array.isArray(raw)
  ? raw.map((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return value;
      const item = value as Record<string, unknown>;
      return item.guestIndex === undefined && Array.isArray(item.guestIndices) && item.guestIndices.length
        ? { ...item, guestIndex: item.guestIndices[0] }
        : item;
    })
  : raw, VoiceBookingItems);
export type VoiceItems = z.infer<typeof voiceItems>;
/** Consecutive returned times only; never fill a gap in availability. */
export function compactTimes(times: string[], step: number): string[] {
  const mins = times.map(
    (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)),
  );
  const out: string[] = [];
  for (let i = 0; i < times.length; i++) {
    let j = i;
    while (j + 1 < times.length && mins[j + 1]! - mins[j]! === step) j++;
    out.push(
      j - i >= 2
        ? `${times[i]}-${times[j]}/${step}`
        : times.slice(i, j + 1).join(","),
    );
    i = j;
  }
  return out;
}


type ServiceShape = { serviceId: string; guestCount: number };
export function simpleVoiceItems(service: ServiceShape, partySize?: number, staffId?: string): VoiceItems {
  const guests = partySize ?? service.guestCount;
  if (guests < service.guestCount || guests % service.guestCount !== 0) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, { details: {
      reason: "invalid_service_guests",
      guidance: `This service covers ${service.guestCount} guests per item. Clarify the party size before searching again.`,
    } });
  }
  return Array.from({ length: guests / service.guestCount }, (_, index) => {
    const guestIndex = index * service.guestCount;
    return { guestIndex, serviceId: service.serviceId, addonIds: [], staffId: staffId ?? null,
      ...(service.guestCount > 1 ? { guestIndices: Array.from({ length: service.guestCount }, (_, n) => guestIndex + n) } : {}),
    };
  });
}

export function assertSharedVoiceSelection(items: VoiceItems, services: ServiceShape[]): void {
  const coveredByService = new Map<string, Set<number>>();
  for (const [index, item] of items.entries()) {
    const service = services.find(s => s.serviceId === item.serviceId);
    if (!service || service.guestCount <= 1) continue;
    const guests = selectionGuests(item);
    if (guests.length !== service.guestCount) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, { details: {
        reason: "invalid_service_guests", itemIndex: index, requiredGuestCount: service.guestCount,
        guidance: "Use one item for a shared service, with guestIndex equal to the first guest and guestIndices listing all its guests. Do not send one shared-service item per person.",
      } });
    }
    const seen = coveredByService.get(item.serviceId) ?? new Set<number>();
    if (guests.some(guest => seen.has(guest))) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, { details: {
        reason: "duplicate_shared_service", itemIndex: index,
        guidance: "The same guests appear in this shared service more than once. Use one item per group. If the caller really wants repeated sessions for the same group, offer staff assistance.",
      } });
    }
    guests.forEach(guest => seen.add(guest));
    coveredByService.set(item.serviceId, seen);
  }
}
