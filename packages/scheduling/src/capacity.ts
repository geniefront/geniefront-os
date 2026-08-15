/**
 * 容量检查（01-ARCHITECTURE §7.1，宪法第 15 条）
 *
 * 三层约束里，这个文件只管**软的那两层**：
 *   技师并发 —— staff_profiles.max_concurrent_appointments，默认 1，美甲店可设 2
 *   门店时段 —— settings.capacity.max_concurrent_per_slot，默认 = 在岗可接客人数
 *
 * 资源（房间/床/椅）是**硬约束，由数据库排他约束负责**，不在这里。
 * 理由：资源冲突物理上不可能放行，而软约束前台要能带 reason 覆盖。
 * 把两者混在一起判断，迟早会有人给软约束也加上 DB 约束。
 *
 * 纯函数，无 IO。
 */

export interface Interval {
  startsAt: Date;
  endsAt: Date;
}

export interface StaffCapacity {
  membershipId: string;
  /** 默认 1。美甲店做手时脚在泡水/等干，可设 2 */
  maxConcurrent: number;
  isBookable: boolean;
  /** 该技师当天已有的活跃时段（不含被取消的） */
  existing: readonly Interval[];
}

export interface LocationCapacity {
  /** null = 自动取该时段在岗且 is_bookable 的员工数 */
  maxConcurrentPerSlot: number | null;
  onDutyBookableCount: number;
  /** 全店当天已有的活跃时段 */
  existing: readonly Interval[];
}

export type CapacityIssue =
  | {
      code: 'STAFF_NOT_BOOKABLE';
      membershipId: string;
      /** 硬性：这不是「超卖」，是这个人根本不接客 */
      overridable: false;
    }
  | {
      code: 'STAFF_OVER_CAPACITY';
      membershipId: string;
      limit: number;
      wouldBe: number;
      overridable: true;
    }
  | {
      code: 'LOCATION_OVER_CAPACITY';
      limit: number;
      wouldBe: number;
      /** 峰值出现在哪一刻，前台看板要高亮这个时间 */
      peakAt: Date;
      overridable: true;
    };

const overlaps = (a: Interval, b: Interval) =>
  a.startsAt < b.endsAt && b.startsAt < a.endsAt;

/**
 * 检查一个拟新增的时段。
 *
 * 返回空数组 = 放行。返回的每一项都带 `overridable`：
 * 前台带 reason 时只能覆盖 overridable 为 true 的，
 * STAFF_NOT_BOOKABLE 是配置问题（这人根本不接客），覆盖没有意义。
 */
export function checkCapacity(args: {
  proposed: Interval;
  staff: StaffCapacity | null;
  location: LocationCapacity;
}): CapacityIssue[] {
  const { proposed, staff, location } = args;
  const issues: CapacityIssue[] = [];

  if (proposed.endsAt <= proposed.startsAt) {
    throw new Error('结束时间必须晚于开始时间');
  }

  // ── 技师层 ────────────────────────────────────────────────────────────────
  if (staff) {
    if (!staff.isBookable) {
      issues.push({ code: 'STAFF_NOT_BOOKABLE', membershipId: staff.membershipId, overridable: false });
    } else {
      const concurrent = staff.existing.filter((e) => overlaps(e, proposed)).length + 1;
      if (concurrent > staff.maxConcurrent) {
        issues.push({
          code: 'STAFF_OVER_CAPACITY',
          membershipId: staff.membershipId,
          limit: staff.maxConcurrent,
          wouldBe: concurrent,
          overridable: true,
        });
      }
    }
  }

  // ── 门店层 ────────────────────────────────────────────────────────────────
  const limit = location.maxConcurrentPerSlot ?? location.onDutyBookableCount;
  // 上限为 0 说明今天没人在岗；那是排班问题，不该用容量报错去表达
  if (limit > 0) {
    const peak = peakConcurrency([...location.existing, proposed], proposed);
    if (peak.count > limit) {
      issues.push({
        code: 'LOCATION_OVER_CAPACITY',
        limit,
        wouldBe: peak.count,
        peakAt: peak.at,
        overridable: true,
      });
    }
  }

  return issues;
}

/**
 * 扫描线求峰值并发。
 *
 * 只看落在 `within` 区间内的时刻 —— 别处的峰值不该拦住这一单。
 * 端点用 (start:+1, end:-1) 且**先减后加**，这样首尾相接的两单
 * （10:00–11:00 与 11:00–12:00）不会被算成并发 2。
 */
function peakConcurrency(intervals: readonly Interval[], within: Interval): { count: number; at: Date } {
  const events: Array<{ t: number; delta: number }> = [];
  for (const i of intervals) {
    events.push({ t: i.startsAt.getTime(), delta: 1 });
    events.push({ t: i.endsAt.getTime(), delta: -1 });
  }
  events.sort((a, b) => (a.t - b.t) || (a.delta - b.delta));

  let cur = 0;
  let best = 0;
  let bestAt = within.startsAt;
  const lo = within.startsAt.getTime();
  const hi = within.endsAt.getTime();

  for (const e of events) {
    cur += e.delta;
    if (e.delta === 1 && e.t >= lo && e.t < hi && cur > best) {
      best = cur;
      bestAt = new Date(e.t);
    }
  }
  return { count: best, at: bestAt };
}

/** 只保留可被前台覆盖的问题 */
export const overridableOnly = (issues: readonly CapacityIssue[]) =>
  issues.filter((i) => i.overridable);

/** 有没有覆盖不了的问题 —— 有的话前台带 reason 也没用 */
export const hasBlocking = (issues: readonly CapacityIssue[]) =>
  issues.some((i) => !i.overridable);
