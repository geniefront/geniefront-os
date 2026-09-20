import { checkCapacity, type Interval } from "./capacity";

export interface PartyItem {
  resourceTypeId?: string | null;
  guestIndex: number;
  serviceId: string;
  addonIds: string[];
  durationMin: number;
  priceCents: number;
  staffId: string | null;
  eligibleStaffIds: string[];
}
export interface PartyStaff {
  id: string;
  startsAt: Date;
  endsAt: Date;
}
export interface PlannedPartyItem extends PartyItem {
  resourceId?: string | null;
  startsAt: string;
  endsAt: string;
  staffId: string | null;
}

/** Same start for all guests; consecutive services for each guest. Backtracking
 * avoids consuming the only qualified specialist for a later service. */
export function planPartyAt(args: {
  startsAt: Date;
  closesAt: Date;
  items: readonly PartyItem[];
  staff: readonly PartyStaff[];
  existing: readonly (Interval & { membershipId: string | null })[];
  locationLimit: number;
  allowUnassigned?: boolean;
  unassignedLimit?: number;
  resources?: ReadonlyArray<{
    id: string;
    typeId: string;
    capacity: number;
    maxStaff: number | null;
    busy: ReadonlyArray<Interval & { membershipId: string | null }>;
  }>;
}): PlannedPartyItem[] | null {
  if (!args.items.length || args.items.length > 20 || args.locationLimit < 1)
    return null;
  const ends = new Map<number, number>();
  const shape = args.items.map((item, position) => {
    const start = ends.get(item.guestIndex) ?? args.startsAt.getTime();
    const end = start + item.durationMin * 60000;
    ends.set(item.guestIndex, end);
    return { item, position, startsAt: new Date(start), endsAt: new Date(end) };
  });
  if (
    shape.some(
      (s) =>
        s.item.durationMin <= 0 ||
        !Number.isFinite(s.endsAt.getTime()) ||
        s.endsAt > args.closesAt,
    )
  )
    return null;
  // Resolve constrained assignments first; keep the original display sequence.
  shape.sort(
    (a, b) =>
      (a.item.staffId ? 1 : a.item.eligibleStaffIds.length) -
        (b.item.staffId ? 1 : b.item.eligibleStaffIds.length) ||
      Number(!!b.item.resourceTypeId) - Number(!!a.item.resourceTypeId) ||
      a.startsAt.getTime() - b.startsAt.getTime(),
  );
  const planned: Array<PlannedPartyItem & { position: number }> = [];
  let attempts = 0;
  const visit = (index: number): boolean => {
    if (index === shape.length) return true;
    if (++attempts > 10000) return false;
    const { item, position, startsAt, endsAt } = shape[index]!;
    const existing = [
      ...args.existing,
      ...planned.map((p) => ({
        startsAt: new Date(p.startsAt),
        endsAt: new Date(p.endsAt),
        membershipId: p.staffId,
        groupKey: `party:${p.guestIndex}`,
      })),
    ];
    const proposed = { startsAt, endsAt, groupKey: `party:${item.guestIndex}` };
    for (const staff of args.staff) {
      if (item.staffId && staff.id !== item.staffId) continue;
      if (
        !item.eligibleStaffIds.includes(staff.id) ||
        staff.startsAt > startsAt ||
        staff.endsAt < endsAt
      )
        continue;
      // A public guest is promised one specialist's time, even when internal
      // overbooking policy allows processing-time concurrency.
      const issues = checkCapacity({
        proposed,
        staff: {
          membershipId: staff.id,
          maxConcurrent: 1,
          isBookable: true,
          existing: existing.filter((e) => e.membershipId === staff.id),
        },
        location: {
          maxConcurrentPerSlot: args.locationLimit,
          onDutyBookableCount: args.staff.length,
          existing,
        },
      });
      if (issues.length) continue;
      const resources = item.resourceTypeId
        ? (args.resources ?? []).filter((r) => r.typeId === item.resourceTypeId)
        : [null];
      for (const resource of resources) {
        if (resource) {
          const busy = [
            ...resource.busy,
            ...planned
              .filter((p) => p.resourceId === resource.id)
              .map((p) => ({
                startsAt: new Date(p.startsAt),
                endsAt: new Date(p.endsAt),
                membershipId: p.staffId,
                groupKey: `party:${p.guestIndex}`,
              })),
          ].filter((b) => b.startsAt < endsAt && startsAt < b.endsAt);
          const groups = new Set(busy.map((b, i) => b.groupKey ?? `busy:${i}`));
          const people = new Set(
            busy.map((b) => b.membershipId).filter(Boolean),
          );
          people.add(staff.id);
          if (
            groups.size >= resource.capacity ||
            (resource.maxStaff !== null && people.size > resource.maxStaff)
          )
            continue;
        }
        planned.push({
          ...item,
          position,
          resourceId: resource?.id ?? null,
          staffId: staff.id,
          startsAt: startsAt.toISOString(),
          endsAt: endsAt.toISOString(),
        });
        if (visit(index + 1)) return true;
        planned.pop();
      }
    }
    // Extra capacity is an unassigned booking, never a second promise for a busy specialist.
    if(args.allowUnassigned && !item.staffId && !item.resourceTypeId && args.staff.some(s=>item.eligibleStaffIds.includes(s.id) && s.startsAt<=startsAt && s.endsAt>=endsAt)) {
      const onDuty=new Set(args.staff.filter(s=>s.startsAt<=startsAt && s.endsAt>=endsAt).map(s=>s.id)).size;
      const extra=args.unassignedLimit ?? Math.max(0,args.locationLimit-onDuty);
      const unassigned=existing.filter(e=>!e.membershipId);
      if(extra>0 && checkCapacity({proposed,staff:null,location:{maxConcurrentPerSlot:args.locationLimit,onDutyBookableCount:onDuty,existing}}).length===0 && checkCapacity({proposed,staff:null,location:{maxConcurrentPerSlot:extra,onDutyBookableCount:onDuty,existing:unassigned}}).length===0) {
        planned.push({...item,position,staffId:null,resourceId:null,startsAt:startsAt.toISOString(),endsAt:endsAt.toISOString()});
        if(visit(index+1))return true;
        planned.pop();
      }
    }
    return false;
  };
  return visit(0)
    ? planned
        .sort((a, b) => a.position - b.position)
        .map(({ position: _position, ...item }) => item)
    : null;
}
