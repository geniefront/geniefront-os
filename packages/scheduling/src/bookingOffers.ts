import { checkCapacity, type Interval } from './capacity';
import { bookingLimits, type BookingPolicy } from './bookingPolicy';
import { wallMinuteToInstant } from './roster';

export interface BookingOfferInput {
  date: string; timezone: string; openMin: number; closeMin: number;
  step: number; durationMin: number; earliest: Date; partySize: number;
  assignStaff?: boolean;
  policy: BookingPolicy; preferredMembershipId: string | null;
  staff: Array<{ id: string; maxConcurrent: number; startMin: number; endMin: number }>;
  existing: Array<Interval & { membershipId: string | null }>;
}

/** Shares checkCapacity with writes. General bookings may remain unassigned. */
export function findBookingOffers(input: BookingOfferInput): Array<{ startsAt: string; membershipId: string | null; membershipIds?:Array<string|null> }> {
  const { date, timezone, durationMin, policy, staff, existing, preferredMembershipId: preferred } = input;
  if (input.step < 1 || durationMin < 1 || input.partySize < 1) return [];
  const requested = Boolean(preferred);
  if (requested && (!staff.some(s => s.id === preferred) || input.partySize !== 1)) return [];
  const out: Array<{ startsAt: string; membershipId: string | null; membershipIds?:Array<string|null> }> = [];
  for (let m = Math.ceil(input.openMin / input.step) * input.step; m + durationMin <= input.closeMin; m += input.step) {
    const startsAt = wallMinuteToInstant(date, timezone, m);
    const endsAt = wallMinuteToInstant(date, timezone, m + durationMin);
    if (startsAt < input.earliest || endsAt <= startsAt) continue;
    const availableStaff = staff.filter(s => s.startMin <= m && s.endMin >= m + durationMin);
    const specialist = requested ? availableStaff.find(s => s.id === preferred) : undefined;
    if (requested && !specialist) continue;
    const staffCount = new Set(availableStaff.map(s => s.id)).size;
    const limits = bookingLimits(policy, staffCount, requested, specialist?.maxConcurrent ?? 1);
    if (limits.locationLimit <= 0 || (input.assignStaff && !staffCount)) continue;
    const proposed = { startsAt, endsAt };
    const issues = checkCapacity({ proposed,
      staff: specialist ? { membershipId: specialist.id, maxConcurrent: limits.staffLimit, isBookable: true,
        existing: existing.filter(x => x.membershipId === specialist.id) } : null,
      location: { maxConcurrentPerSlot: limits.locationLimit, onDutyBookableCount: staffCount,
        existing: [...existing, ...Array.from({ length: input.partySize - 1 }, () => proposed)] },
    });
    if (issues.length === 0) {
      let membershipId=preferred;
      let membershipIds:Array<string|null>|undefined;
      if(input.assignStaff && !preferred) {
        const free=availableStaff.filter(s=>!existing.some(e=>e.membershipId===s.id&&e.startsAt<endsAt&&e.endsAt>startsAt));
        membershipIds=free.slice(0,input.partySize).map(s=>s.id);
        const missing=input.partySize-membershipIds.length;
        if(missing) {
          const extra=policy.bufferEnabled?policy.bufferExtra:0;
          if(!extra || checkCapacity({proposed,staff:null,location:{maxConcurrentPerSlot:extra,onDutyBookableCount:staffCount,existing:[...existing.filter(e=>!e.membershipId),...Array.from({length:missing-1},()=>proposed)]}}).length)continue;
          membershipIds.push(...Array.from({length:missing},()=>null));
        }
        membershipId=input.partySize===1?membershipIds[0]??null:null;
      }
      out.push({ startsAt: startsAt.toISOString(), membershipId, ...(membershipIds?{membershipIds}:{}) });
    }
    if (out.length >= 100) break;
  }
  return out;
}
