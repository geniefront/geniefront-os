import { describe, it, expect } from 'vitest';
import { checkCapacity, hasBlocking, type Interval } from './capacity';
import { businessDateOf, businessDayMinutes } from './business-day';

const iv = (s: string, e: string): Interval => ({ startsAt: new Date(s), endsAt: new Date(e) });

const noLimit = { maxConcurrentPerSlot: 99, onDutyBookableCount: 99, existing: [] };

describe('技师并发（软约束）', () => {
  it('默认 1 个并发：不重叠就放行', () => {
    const issues = checkCapacity({
      proposed: iv('2026-08-20T14:00:00Z', '2026-08-20T15:00:00Z'),
      staff: { membershipId: 'm1', maxConcurrent: 1, isBookable: true,
               existing: [iv('2026-08-20T15:00:00Z', '2026-08-20T16:00:00Z')] },
      location: noLimit,
    });
    expect(issues).toEqual([]);
  });

  it('首尾相接不算并发（15:00 结束 + 15:00 开始）', () => {
    const issues = checkCapacity({
      proposed: iv('2026-08-20T15:00:00Z', '2026-08-20T16:00:00Z'),
      staff: { membershipId: 'm1', maxConcurrent: 1, isBookable: true,
               existing: [iv('2026-08-20T14:00:00Z', '2026-08-20T15:00:00Z')] },
      location: noLimit,
    });
    expect(issues).toEqual([]);
  });

  it('重叠超过上限 → 软告警，可覆盖', () => {
    const issues = checkCapacity({
      proposed: iv('2026-08-20T14:30:00Z', '2026-08-20T15:30:00Z'),
      staff: { membershipId: 'm1', maxConcurrent: 1, isBookable: true,
               existing: [iv('2026-08-20T14:00:00Z', '2026-08-20T15:00:00Z')] },
      location: noLimit,
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: 'STAFF_OVER_CAPACITY', limit: 1, wouldBe: 2, overridable: true });
    expect(hasBlocking(issues)).toBe(false);
  });

  it('⭐ 美甲店把上限设成 2 → 做手时脚在泡水，压两单是合法的', () => {
    const issues = checkCapacity({
      proposed: iv('2026-08-20T14:30:00Z', '2026-08-20T15:30:00Z'),
      staff: { membershipId: 'm1', maxConcurrent: 2, isBookable: true,
               existing: [iv('2026-08-20T14:00:00Z', '2026-08-20T15:00:00Z')] },
      location: noLimit,
    });
    expect(issues).toEqual([]);
  });

  it('不接客的人（纯前台）→ 硬性拦截，覆盖没有意义', () => {
    const issues = checkCapacity({
      proposed: iv('2026-08-20T14:00:00Z', '2026-08-20T15:00:00Z'),
      staff: { membershipId: 'front', maxConcurrent: 1, isBookable: false, existing: [] },
      location: noLimit,
    });
    expect(issues[0]).toMatchObject({ code: 'STAFF_NOT_BOOKABLE', overridable: false });
    expect(hasBlocking(issues)).toBe(true);
  });

  it('⭐ 同一位客人的两个项目（同一技师、时间重叠）算一个占位', () => {
    // 做手的同时脚在泡水 —— 一位客人，一个位置
    const issues = checkCapacity({
      proposed: { ...iv('2026-08-20T14:00:00Z', '2026-08-20T15:00:00Z'), groupKey: 'appt-1' },
      staff: {
        membershipId: 'm1', maxConcurrent: 1, isBookable: true,
        existing: [{ ...iv('2026-08-20T14:00:00Z', '2026-08-20T14:30:00Z'), groupKey: 'appt-1' }],
      },
      location: noLimit,
    });
    expect(issues).toEqual([]);
  });

  it('换成两位客人，同样的时间就超了', () => {
    const issues = checkCapacity({
      proposed: { ...iv('2026-08-20T14:00:00Z', '2026-08-20T15:00:00Z'), groupKey: 'appt-2' },
      staff: {
        membershipId: 'm1', maxConcurrent: 1, isBookable: true,
        existing: [{ ...iv('2026-08-20T14:00:00Z', '2026-08-20T14:30:00Z'), groupKey: 'appt-1' }],
      },
      location: noLimit,
    });
    expect(issues[0]).toMatchObject({ code: 'STAFF_OVER_CAPACITY', limit: 1, wouldBe: 2 });
  });

  it('同一位客人占一个位，另一位客人再来才是第二个', () => {
    const existing = [
      { ...iv('2026-08-20T14:00:00Z', '2026-08-20T15:00:00Z'), groupKey: 'appt-1' },
      { ...iv('2026-08-20T14:00:00Z', '2026-08-20T15:00:00Z'), groupKey: 'appt-1' },
      { ...iv('2026-08-20T14:00:00Z', '2026-08-20T15:00:00Z'), groupKey: 'appt-2' },
    ];
    const issues = checkCapacity({
      proposed: { ...iv('2026-08-20T14:30:00Z', '2026-08-20T15:30:00Z'), groupKey: 'appt-3' },
      staff: { membershipId: 'm1', maxConcurrent: 2, isBookable: true, existing },
      location: noLimit,
    });
    // appt-1 + appt-2 + 自己 = 3 位客人，上限 2
    expect(issues[0]).toMatchObject({ code: 'STAFF_OVER_CAPACITY', limit: 2, wouldBe: 3 });
  });

  it('没有 groupKey 时行为与从前一致（各算各的）', () => {
    const issues = checkCapacity({
      proposed: iv('2026-08-20T14:30:00Z', '2026-08-20T15:30:00Z'),
      staff: { membershipId: 'm1', maxConcurrent: 1, isBookable: true,
               existing: [iv('2026-08-20T14:00:00Z', '2026-08-20T15:00:00Z')] },
      location: noLimit,
    });
    expect(issues[0]).toMatchObject({ code: 'STAFF_OVER_CAPACITY', wouldBe: 2 });
  });

  it('未指定技师（前台稍后派单）→ 只查门店层', () => {
    const issues = checkCapacity({
      proposed: iv('2026-08-20T14:00:00Z', '2026-08-20T15:00:00Z'),
      staff: null,
      location: noLimit,
    });
    expect(issues).toEqual([]);
  });
});

describe('门店时段总量（软约束）', () => {
  it('上限自动取在岗可接客人数', () => {
    const existing = [
      iv('2026-08-20T14:00:00Z', '2026-08-20T15:00:00Z'),
      iv('2026-08-20T14:00:00Z', '2026-08-20T15:00:00Z'),
    ];
    const issues = checkCapacity({
      proposed: iv('2026-08-20T14:30:00Z', '2026-08-20T15:30:00Z'),
      staff: null,
      location: { maxConcurrentPerSlot: null, onDutyBookableCount: 2, existing },
    });
    expect(issues[0]).toMatchObject({ code: 'LOCATION_OVER_CAPACITY', limit: 2, wouldBe: 3 });
  });

  it('峰值只看落在本单区间内的时刻 —— 别处的高峰不该拦住这一单', () => {
    const existing = [
      iv('2026-08-20T09:00:00Z', '2026-08-20T10:00:00Z'),
      iv('2026-08-20T09:00:00Z', '2026-08-20T10:00:00Z'),
      iv('2026-08-20T09:00:00Z', '2026-08-20T10:00:00Z'),
    ];
    const issues = checkCapacity({
      proposed: iv('2026-08-20T14:00:00Z', '2026-08-20T15:00:00Z'),
      staff: null,
      location: { maxConcurrentPerSlot: 2, onDutyBookableCount: 2, existing },
    });
    expect(issues).toEqual([]);
  });

  it('⭐ 门店层同样按客人算：一位客人的多个项目不该顶掉整店容量', () => {
    // 两位客人在店里，其中一位做三个项目 —— 店里还是两位客人
    const existing = [
      { ...iv('2026-08-20T14:00:00Z', '2026-08-20T15:00:00Z'), groupKey: 'appt-1' },
      { ...iv('2026-08-20T14:00:00Z', '2026-08-20T15:00:00Z'), groupKey: 'appt-1' },
      { ...iv('2026-08-20T14:10:00Z', '2026-08-20T15:00:00Z'), groupKey: 'appt-1' },
      { ...iv('2026-08-20T14:00:00Z', '2026-08-20T15:00:00Z'), groupKey: 'appt-2' },
    ];
    const issues = checkCapacity({
      proposed: { ...iv('2026-08-20T14:30:00Z', '2026-08-20T15:30:00Z'), groupKey: 'appt-3' },
      staff: null,
      location: { maxConcurrentPerSlot: 3, onDutyBookableCount: 3, existing },
    });
    expect(issues).toEqual([]);
  });

  it('同一位客人上午一单下午一单，中间的空档不会被并掉', () => {
    const existing = [
      { ...iv('2026-08-20T09:00:00Z', '2026-08-20T10:00:00Z'), groupKey: 'appt-1' },
      { ...iv('2026-08-20T14:00:00Z', '2026-08-20T15:00:00Z'), groupKey: 'appt-1' },
      { ...iv('2026-08-20T14:00:00Z', '2026-08-20T15:00:00Z'), groupKey: 'appt-2' },
    ];
    const issues = checkCapacity({
      proposed: { ...iv('2026-08-20T14:30:00Z', '2026-08-20T15:30:00Z'), groupKey: 'appt-3' },
      staff: null,
      location: { maxConcurrentPerSlot: 2, onDutyBookableCount: 2, existing },
    });
    expect(issues[0]).toMatchObject({ code: 'LOCATION_OVER_CAPACITY', limit: 2, wouldBe: 3 });
  });

  it('今天没人在岗时不用容量报错去表达（那是排班问题）', () => {
    const issues = checkCapacity({
      proposed: iv('2026-08-20T14:00:00Z', '2026-08-20T15:00:00Z'),
      staff: null,
      location: { maxConcurrentPerSlot: null, onDutyBookableCount: 0, existing: [] },
    });
    expect(issues).toEqual([]);
  });
});

describe('营业日边界（宪法第 8 条）', () => {
  const LA = 'America/Los_Angeles';
  const NY = 'America/New_York';

  it('⭐ 足疗店 cutoff 03:00：凌晨 1:30 的单算前一天', () => {
    // 2026-08-21 01:30 LA = 08:30 UTC
    expect(businessDateOf(new Date('2026-08-21T08:30:00Z'), LA, '03:00')).toBe('2026-08-20');
  });

  it('同一家店 04:00 的单算当天', () => {
    expect(businessDateOf(new Date('2026-08-21T11:00:00Z'), LA, '03:00')).toBe('2026-08-21');
  });

  it('美甲店 cutoff 21:00：晚上 10 点的单算第二天（少见但要正确）', () => {
    // 2026-08-20 22:00 NY = 2026-08-21 02:00 UTC
    expect(businessDateOf(new Date('2026-08-21T02:00:00Z'), NY, '21:00')).toBe('2026-08-20');
  });

  it('时区确实生效：同一时刻在东西岸属于不同营业日', () => {
    // 2026-08-21 02:30 UTC = NY 前一天 22:30，LA 前一天 19:30
    const t = new Date('2026-08-21T02:30:00Z');
    expect(businessDateOf(t, NY, '03:00')).toBe('2026-08-20');
    expect(businessDateOf(t, LA, '03:00')).toBe('2026-08-20');
    // 而 2026-08-21 07:30 UTC = NY 03:30（当天），LA 00:30（前一天）
    const t2 = new Date('2026-08-21T07:30:00Z');
    expect(businessDateOf(t2, NY, '03:00')).toBe('2026-08-21');
    expect(businessDateOf(t2, LA, '03:00')).toBe('2026-08-20');
  });

  it('平常日子是 24 小时', () => {
    expect(businessDayMinutes('2026-08-20', NY, '03:00')).toBe(24 * 60);
  });

  // 美国 DST 在【当地 02:00】切换：
  //   2026-03-08 春季 02:00 → 03:00（少一小时）
  //   2026-11-01 秋季 02:00 → 01:00（多一小时）
  // 门店的营业日是 03:00 → 次日 03:00，所以切换点落在【前一天】的营业日里。

  it('⭐ DST 春季：切换落在 03-07 的营业日内（周六 03:00 → 周日 03:00）→ 23 小时', () => {
    expect(businessDayMinutes('2026-03-07', NY, '03:00')).toBe(23 * 60);
  });

  it('⭐ DST 秋季：切换落在 10-31 的营业日内 → 25 小时', () => {
    expect(businessDayMinutes('2026-10-31', NY, '03:00')).toBe(25 * 60);
  });

  it('⭐ 切换当天本身反而是整 24 小时 —— 03:00 的 cutoff 把切换点甩到了前一天', () => {
    expect(businessDayMinutes('2026-03-08', NY, '03:00')).toBe(24 * 60);
    expect(businessDayMinutes('2026-11-01', NY, '03:00')).toBe(24 * 60);
  });

  it('cutoff 设成 00:00（按自然日）时，异常就回到切换当天', () => {
    expect(businessDayMinutes('2026-03-08', NY, '00:00')).toBe(23 * 60);
    expect(businessDayMinutes('2026-11-01', NY, '00:00')).toBe(25 * 60);
  });

  it('⭐ 跨过秋季回拨那一小时时，01:30 出现两次 —— 两次都必须归到同一个营业日', () => {
    // 2026-11-01 01:30 EDT = 05:30 UTC；回拨后 01:30 EST = 06:30 UTC
    expect(businessDateOf(new Date('2026-11-01T05:30:00Z'), NY, '03:00')).toBe('2026-10-31');
    expect(businessDateOf(new Date('2026-11-01T06:30:00Z'), NY, '03:00')).toBe('2026-10-31');
  });
});
