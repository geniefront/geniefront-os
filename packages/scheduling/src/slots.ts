/**
 * 找真实空档（09-TELNYX §8 的那条护栏）
 *
 * ⭐ 存在的理由只有一条：**AI 永远不许自己算时间**。
 *
 * 电话 AI 报出口的每一个时间，都必须是这个函数返回过的。
 * 让模型自己算「那明天下午三点行吗」，它会算出一个店里根本没人在班的时间，
 * 而客人在电话里听到的是一句肯定的答复 —— 等他到店才发现没这回事。
 * 这类错误是**静默**的：前台复核时看到「明天 15:00」也不会觉得有问题。
 *
 * 同一个函数也给前台的「最近有空的是什么时候」用 ——
 * 排期只能有一份实现（宪法第 2 条）。纯函数，无 IO。
 *
 * ⚠️ 这不是完整排期引擎。技能匹配、双技师、缓冲时间、处理时间重叠
 * （做完头发等上色的那 20 分钟能插别人）都还没有，见 `03` Phase 1b 的遗留项。
 * 现在的口径是保守的：**宁可少报空档，不可多报** ——
 * 少报只是让客人换个时间，多报是让他白跑一趟。
 */

import { checkCapacity, type Interval } from './capacity';

export interface StaffAvailability {
  membershipId: string;
  /** 显示用。电话 AI 要能说出「Amy 四点有空」 */
  name: string;
  /** 当天班次的上下班时刻，按门店墙上时间的「营业日分钟」计（与 roster 同一口径） */
  shiftStartMin: number;
  shiftEndMin: number;
  /** 已经占着的时段（不含已取消的） */
  busy: readonly Interval[];
  /** 默认 1。美甲店做手时脚在泡水，可设 2 */
  maxConcurrent: number;
}

export interface FindSlotsArgs {
  businessDate: string;
  timezone: string;
  /** 营业日分钟。把墙上时间换算成 Date 用 roster 的 wallMinuteToInstant */
  openMin: number;
  closeMin: number;
  /** 这一单要做多久 */
  durationMin: number;
  staff: readonly StaffAvailability[];
  /** 排班粒度。多数店 15 分钟，按摩店常 30 */
  slotMinutes?: number;
  /** 客人点名要谁。给了就只在这个人身上找 */
  preferredMembershipId?: string | null;
  /**
   * ⭐ 候选技师集（性别偏好等）。给了就只在这几个人身上找。
   *
   * 存在的理由是**顺序**：筛选必须发生在找空档**之前**。
   * 先算出全店的空档、再按性别过滤，会漏掉本可安排的时段 ——
   * 女技师十点有空、男技师十点也有空，limit 先被男技师占满，
   * 过滤完就成了「十点没有女技师」，而实际上有。
   */
  candidateMembershipIds?: readonly string[] | null;
  /**
   * ⭐ 同行几位客人。>1 时**同一时刻必须有这么多位技师同时有空**。
   *
   * 刻意不拿 maxConcurrent 去凑数：并发 2 的美甲师是「做手的时候
   * 另一只脚在泡水」，不是「同时伺候两位客人」。两位客人一起来，
   * 就是要两个人。宁可少报（让客人换时间），不可多报（让两个人白跑）。
   */
  partySize?: number;
  /**
   * 门店层容量（软约束，01 §7.1）。不给就不查。
   *
   * 走 `checkCapacity` 而不是在这里另算一遍 —— 建单时拦人的是它，
   * 找空档时报时间的也必须是它，否则 AI 报出来的时段建单时会被驳回。
   */
  location?: {
    maxConcurrentPerSlot: number | null;
    /** 全店当天已占用的时段（含未派技师的） */
    busy: readonly Interval[];
  } | null;
  /** 客人说的时间窗（营业日分钟）。不给就整天找 */
  windowStartMin?: number;
  windowEndMin?: number;
  /** 「现在」之前的空档不能报 —— 客人打电话时已经是下午两点了 */
  nowMin?: number;
  /** 最多返回几个。电话里报三个已经是极限，报五个客人记不住 */
  limit?: number;
  /** 把营业日分钟换成真实时刻。注入是为了让这个函数保持纯粹（DST 由调用方负责） */
  toInstant: (businessDate: string, timezone: string, minutes: number) => Date;
}

export interface OpenSlot {
  membershipId: string;
  staffName: string;
  /** 营业日分钟，排序与去重用 */
  startMin: number;
  startsAt: Date;
  endsAt: Date;
}

const overlaps = (a: Interval, b: Interval) =>
  a.startsAt < b.endsAt && b.startsAt < a.endsAt;

/**
 * 找出这一天所有能放下 `durationMin` 的起始点。
 *
 * 一个刻意的取舍：**同一时刻多个技师有空时，每个人各返回一条**，
 * 不合并成「这个点有空」。因为电话里客人常常是奔着人去的
 * （「Amy 在不在」），而前台复核时也要看到系统建议派给谁。
 * 上层要展示「几点有空」的话，按 startMin 去重即可。
 */
export function findOpenSlots(args: FindSlotsArgs): OpenSlot[] {
  const {
    businessDate, timezone, openMin, closeMin, durationMin, staff,
    slotMinutes = 15, preferredMembershipId = null,
    candidateMembershipIds = null, partySize = 1, location = null,
    nowMin, limit = 5, toInstant,
  } = args;

  if (durationMin <= 0 || staff.length === 0) return [];

  // 时间窗与营业时间取交集。客人说「下午」而店里下午两点才开门，
  // 那就是两点起 —— 不是报一个「12:00 有空」然后让他吃闭门羹。
  const from = Math.max(openMin, args.windowStartMin ?? openMin, nowMin ?? openMin);
  const until = Math.min(closeMin, args.windowEndMin ?? closeMin);
  if (from >= until) return [];

  // 两层筛选都在这里、都在找空档**之前**：点名的那一位优先，
  // 没点名则收窄到候选集（性别偏好等）
  const pool = preferredMembershipId
    ? staff.filter((s) => s.membershipId === preferredMembershipId)
    : candidateMembershipIds
      ? staff.filter((s) => candidateMembershipIds.includes(s.membershipId))
      : staff;
  if (pool.length === 0) return [];

  // 同行人数比候选技师还多，一个空档都不可能有 —— 早退出，别空转一整天的格子
  const party = Math.max(1, Math.floor(partySize));
  if (pool.length < party) return [];

  const out: OpenSlot[] = [];

  // 按格子走。起点对齐到 slotMinutes 的整数倍 ——
  // 报「14:07 有空」是荒唐的，前台还得心算改成 14:00。
  const first = Math.ceil(from / slotMinutes) * slotMinutes;

  for (let startMin = first; startMin + durationMin <= until; startMin += slotMinutes) {
    const endMin = startMin + durationMin;
    const startsAt = toInstant(businessDate, timezone, startMin);
    const endsAt = toInstant(businessDate, timezone, endMin);
    const candidate: Interval = { startsAt, endsAt };

    const free = pool.filter((s) => {
      // 必须整段落在班次内。跨过下班时间的单意味着让技师加班 ——
      // 那是前台跟技师商量的事，不该由 AI 在电话里替他答应
      if (startMin < s.shiftStartMin || endMin > s.shiftEndMin) return false;
      return s.busy.filter((b) => overlaps(candidate, b)).length < s.maxConcurrent;
    });

    // 一起来的两位客人要两个人接。凑不齐就整个时刻都不报
    if (free.length < party) continue;
    if (location && !locationHasRoom(location, candidate, party, staff.length)) continue;

    for (const s of free) {
      out.push({
        membershipId: s.membershipId,
        staffName: s.name,
        startMin,
        startsAt,
        endsAt,
      });
      if (out.length >= limit) return out;
    }
  }

  return out;
}

/**
 * 门店同时段能不能再塞下 `party` 位客人。
 *
 * 判断本身**不在这里** —— 转给 `checkCapacity`（同一个文件里那条建单时
 * 用的软约束）。多一份实现就多一种「找空档说有、建单说超了」的可能。
 *
 * party 位客人是 party 条并发的单，所以除了被检查的那一条，
 * 另外 party-1 条要先并进 existing 里一起求峰值。
 */
function locationHasRoom(
  location: NonNullable<FindSlotsArgs['location']>,
  proposed: Interval,
  party: number,
  onDutyBookableCount: number,
): boolean {
  const issues = checkCapacity({
    proposed,
    staff: null,
    location: {
      maxConcurrentPerSlot: location.maxConcurrentPerSlot,
      onDutyBookableCount,
      existing: [
        ...location.busy,
        ...Array.from({ length: party - 1 }, () => proposed),
      ],
    },
  });
  return !issues.some((i) => i.code === 'LOCATION_OVER_CAPACITY');
}

/**
 * 电话里要报的那两三个时间。
 *
 * 按时刻去重（同一时刻只报一次，附带哪些人有空），并**优先靠近客人说的时间** ——
 * 客人说「四点左右」，先报 16:00 再报 15:30，比从早上一路报过来有用得多。
 */
export function summariseSlots(
  slots: readonly OpenSlot[],
  aroundMin?: number,
  take = 3,
): Array<{ startMin: number; startsAt: Date; staff: Array<{ membershipId: string; name: string }> }> {
  const byStart = new Map<number, OpenSlot[]>();
  for (const s of slots) {
    if (!byStart.has(s.startMin)) byStart.set(s.startMin, []);
    byStart.get(s.startMin)!.push(s);
  }

  const groups = [...byStart.entries()].map(([startMin, list]) => ({
    startMin,
    startsAt: list[0]!.startsAt,
    staff: list.map((s) => ({ membershipId: s.membershipId, name: s.staffName })),
  }));

  groups.sort((a, b) => (aroundMin === undefined
    ? a.startMin - b.startMin
    // 距离相同时（客人说四点，15:30 与 16:30 都差 30 分钟）取靠前的：
    // 早一点的空档更可能还在，晚的容易在复核期间被别人订走
    : (Math.abs(a.startMin - aroundMin) - Math.abs(b.startMin - aroundMin))
      || (a.startMin - b.startMin)));

  return groups.slice(0, take);
}
