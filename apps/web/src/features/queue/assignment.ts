import type { DayItem, DayService, DayStaff } from '@/features/schedule/types';
import type { RotationEntry } from '@/features/rotation/types';

export interface StaffCandidate {
  staff: DayStaff;
  eligible: boolean;
  online: boolean;
  reasons: Array<'skill_match' | 'skill_missing' | 'available' | 'busy' | 'on_break' | 'off_duty' | 'requested' | 'offline'>;
  score: number;
}

export function rankStaffCandidates(args: {
  staff: DayStaff[];
  service: DayService;
  rotationEntries: RotationEntry[];
  scheduledItems: DayItem[];
  onlineIds: ReadonlySet<string>;
  requestedStaffId?: string | null;
  nowMs: number;
}): StaffCandidate[] {
  const rotation = new Map(args.rotationEntries.map((entry) => [entry.membershipId, entry]));
  return args.staff.filter((member) => member.isBookable).map((member) => {
    const entry = rotation.get(member.membershipId);
    const hasSkills = args.service.requiredSkills.every((required) => (
      member.skills.some((skill) => skill.id === required.id)
    ));
    const activeCount = args.scheduledItems.filter((item) => (
      item.membershipId === member.membershipId
      && item.status !== 'done'
      && new Date(item.startsAt).getTime() <= args.nowMs
      && new Date(item.endsAt).getTime() > args.nowMs
    )).length;
    const requested = args.requestedStaffId === member.membershipId;
    // A requested appointment may legitimately belong to a bookable specialist
    // who does not participate in walk-in rotation.
    const state = entry?.state ?? (requested ? 'available' : 'not_arrived');
    const onBreak = state === 'on_break';
    const offDuty = state === 'off' || state === 'not_arrived';
    const busy = state === 'in_service' || activeCount >= member.maxConcurrent;
    const online = args.onlineIds.has(member.membershipId);
    const eligible = hasSkills && !onBreak && !offDuty && !busy;
    const reasons: StaffCandidate['reasons'] = [];
    reasons.push(hasSkills ? 'skill_match' : 'skill_missing');
    if (requested) reasons.push('requested');
    if (onBreak) reasons.push('on_break');
    else if (offDuty) reasons.push('off_duty');
    else if (busy) reasons.push('busy');
    else reasons.push('available');
    if (!online) reasons.push('offline');
    const score = (eligible ? 10_000 : 0)
      + (requested ? 2_000 : 0)
      + (online ? 300 : 0)
      + Math.max(0, 200 - (entry?.position ?? 99) * 10)
      - activeCount * 100;
    return { staff: member, eligible, online, reasons, score };
  }).sort((a, b) => b.score - a.score || a.staff.name.localeCompare(b.staff.name));
}
