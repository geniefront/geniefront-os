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
  /**
   * ⭐ 「这是同一位客人的时段」的标识（预约 id / 工单 id）。
   *
   * 一位客人做三个项目、三项都派给同一位技师，占的是**一个**位置，
   * 不是三个 —— 技师并发数问的是「同时在服务几位客人」，不是
   * 「手上挂着几条项目记录」。不带这个键的时段各算各的（老调用点、
   * 以及确实互不相干的散客），行为与引入本字段之前完全一致。
   */
  groupKey?: string | null;
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
 * 与 `proposed` 重叠的**客人数**（而不是时段数）。
 *
 * 带同一个 `groupKey` 的时段合并成一个占位；没有 `groupKey` 的各算一个。
 * `proposed` 自己也算在内 —— 它若与既有时段同属一位客人（加钟、同一张单
 * 的第二个项目），总数就不增加，这正是要放行的那种情况。
 */
export function overlappingOccupancy(
  existing: readonly Interval[], within: Interval,
): number {
  const keys = new Set<string>();
  let ungrouped = 0;
  for (const item of existing) {
    if (!overlaps(item, within)) continue;
    if (item.groupKey) keys.add(item.groupKey);
    else ungrouped += 1;
  }
  return keys.size + ungrouped;
}

/** 加上 `proposed` 自己之后的占位数。它与既有时段同属一位客人时不增加。 */
function occupancyAround(existing: readonly Interval[], proposed: Interval): number {
  if (!proposed.groupKey) return overlappingOccupancy(existing, proposed) + 1;
  const alreadyCounted = existing.some(
    (item) => item.groupKey === proposed.groupKey && overlaps(item, proposed),
  );
  return overlappingOccupancy(existing, proposed) + (alreadyCounted ? 0 : 1);
}

/**
 * 把同一位客人**相互重叠**的时段并成一段，供门店层扫描线使用。
 *
 * 一位客人同时开着两个项目（做手时脚在泡水）在店里占的仍是一把椅子。
 * 只并重叠的那些：同一位客人上午一单、下午一单之间的空档不该被吞掉。
 */
function mergeByGroup(intervals: readonly Interval[]): Interval[] {
  const groups = new Map<string, Interval[]>();
  const out: Interval[] = [];
  for (const item of intervals) {
    if (!item.groupKey) { out.push(item); continue; }
    const bucket = groups.get(item.groupKey);
    if (bucket) bucket.push(item);
    else groups.set(item.groupKey, [item]);
  }
  for (const bucket of groups.values()) {
    const sorted = [...bucket].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
    let cur = { startsAt: sorted[0]!.startsAt, endsAt: sorted[0]!.endsAt };
    for (const item of sorted.slice(1)) {
      if (item.startsAt < cur.endsAt) {
        if (item.endsAt > cur.endsAt) cur = { startsAt: cur.startsAt, endsAt: item.endsAt };
      } else {
        out.push(cur);
        cur = { startsAt: item.startsAt, endsAt: item.endsAt };
      }
    }
    out.push(cur);
  }
  return out;
}

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
      const concurrent = occupancyAround(staff.existing, proposed);
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
    const peak = peakConcurrency(mergeByGroup([...location.existing, proposed]), proposed);
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
 *
 * ⚠️ 必须先把 `lo` 之前的事件消化掉、拿到**区间起点的水位**再开始比较。
 * 只盯着窗口内的「开始」事件是不够的：同一位客人的多个项目被
 * `mergeByGroup` 并成一段之后，这一段的开始时刻可能早于 `lo`，
 * 于是窗口内一个 +1 都没有，峰值会被算成 0。
 */
function peakConcurrency(intervals: readonly Interval[], within: Interval): { count: number; at: Date } {
  const events: Array<{ t: number; delta: number }> = [];
  for (const i of intervals) {
    events.push({ t: i.startsAt.getTime(), delta: 1 });
    events.push({ t: i.endsAt.getTime(), delta: -1 });
  }
  events.sort((a, b) => (a.t - b.t) || (a.delta - b.delta));

  const lo = within.startsAt.getTime();
  const hi = within.endsAt.getTime();

  let cur = 0;
  let cursor = 0;
  // `t <= lo`：正好在 lo 结束的单已经走了（-1 排在 +1 前面），
  // 正好在 lo 开始的单则确实占着位置
  for (; cursor < events.length && events[cursor]!.t <= lo; cursor += 1) {
    cur += events[cursor]!.delta;
  }
  let best = cur;
  let bestAt = new Date(lo);

  for (; cursor < events.length && events[cursor]!.t < hi; cursor += 1) {
    const e = events[cursor]!;
    cur += e.delta;
    if (e.delta === 1 && cur > best) {
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
