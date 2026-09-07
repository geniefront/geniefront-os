import type { DayItem, DayService, DayStaff } from '@/features/schedule/types';
import type { RotationEntry } from '@/features/rotation/types';

export interface StaffCandidate {
  staff: DayStaff;
  eligible: boolean;
  online: boolean;
  reasons: Array<
    | 'skill_match' | 'skill_missing'
    | 'available' | 'busy' | 'on_break' | 'off_duty'
    /** 顾客点钟：客人指名了这一位。 */
    | 'requested'
    /** 预约排班：这一单本来就排给他，但客人没有点钟。 */
    | 'assigned'
    | 'offline'
  >;
  score: number;
}

/**
 * 派单候选排序。
 *
 * ## ⭐ 轮牌是主排序，其余因素只做微调
 *
 * 轮牌决定谁接单，也就决定谁挣钱。因此除了「客人点名」之外，任何因素都不该
 * 把轮牌整体顶掉。分值按「折合多少个轮牌位次」来定，改动时请一并更新这张表：
 *
 * | 因素 | 分值 | 折合位次 |
 * |---|---|---|
 * | 可接单（硬门槛） | 10000 | — |
 * | 顾客点钟 | 5000 | 全场（100 位）|
 * | 预约排班归属 | 120 | 约 2.4 位 |
 * | 轮牌顺位 | 1000 − 位次×50 | 每位 50 |
 * | 手机在线 | 25 | 半位，纯 tiebreaker |
 * | 每有一单在做 | −150 | 3 位 |
 *
 * ⚠️ 这里曾经的问题：`online` 是 300 分而轮牌总跨度只有 200 分（每位 10 分），
 * 于是「技师端 app 有没有连上」能整体压过轮牌顺序 —— 在 Desk-Only 的店里
 * 根本没人开 app，却因此改变了谁接单。现在在线不足一个位次，只在完全并列时
 * 起作用。
 *
 * ⚠️ 另一个问题：调用方传的 `requestedStaffId` 其实是**预约排给谁**，
 * 却被当成「顾客指定」给了 2000 分，并在候选卡上写成「顾客指定」——
 * 客人没有点过钟，前台却被告知不能改人。现在两者分开：真点钟看 `isRequest`。
 */
export function rankStaffCandidates(args: {
  staff: DayStaff[];
  service: DayService;
  rotationEntries: RotationEntry[];
  scheduledItems: DayItem[];
  onlineIds: ReadonlySet<string>;
  /** 这一单排给谁（预约的排班归属）。不代表客人点了钟。 */
  requestedStaffId?: string | null;
  /** 客人是否真的点了钟。只有为 true 时 `requestedStaffId` 才算「顾客指定」。 */
  isRequest?: boolean;
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
    const assigned = Boolean(args.requestedStaffId) && args.requestedStaffId === member.membershipId;
    const requested = assigned && args.isRequest === true;
    // A booked appointment may legitimately belong to a bookable specialist
    // who does not participate in walk-in rotation. Assignment alone is enough
    // to treat them as available here; whether the guest asked for them by name
    // only changes the score, not their presence.
    const state = entry?.state ?? (assigned ? 'available' : 'not_arrived');
    const onBreak = state === 'on_break';
    const offDuty = state === 'off' || state === 'not_arrived';
    const busy = state === 'in_service' || activeCount >= member.maxConcurrent;
    const online = args.onlineIds.has(member.membershipId);
    const eligible = hasSkills && !onBreak && !offDuty && !busy;
    const reasons: StaffCandidate['reasons'] = [];
    reasons.push(hasSkills ? 'skill_match' : 'skill_missing');
    if (requested) reasons.push('requested');
    else if (assigned) reasons.push('assigned');
    if (onBreak) reasons.push('on_break');
    else if (offDuty) reasons.push('off_duty');
    else if (busy) reasons.push('busy');
    else reasons.push('available');
    if (!online) reasons.push('offline');
    const score = (eligible ? 10_000 : 0)
      + (requested ? 5_000 : 0)
      + (assigned && !requested ? 120 : 0)
      + Math.max(0, 1_000 - (entry?.position ?? 99) * 50)
      + (online ? 25 : 0)
      - activeCount * 150;
    return { staff: member, eligible, online, reasons, score };
  }).sort((a, b) => b.score - a.score || a.staff.name.localeCompare(b.staff.name));
}
