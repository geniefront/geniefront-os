/**
 * 找空档的测试。
 *
 * 这一层的每一条都对应「电话里报错一个时间会怎样」：
 * 客人白跑一趟、技师被迫加班、或者两个客人同一时刻被安排给同一个人。
 * 模型那侧不可复现，所以这侧必须钉死。
 */

import { describe, it, expect } from 'vitest';
import { findOpenSlots, summariseSlots, type StaffAvailability } from './slots';

const TZ = 'America/New_York';
const DATE = '2026-08-20';

/** 测试里不关心真实时区换算，只要单调且可比 —— DST 由 wallMinuteToInstant 负责，那边另有测试 */
const toInstant = (_d: string, _tz: string, min: number) => new Date(Date.UTC(2026, 7, 20, 0, min));

const at = (min: number) => toInstant(DATE, TZ, min);

function staff(over: Partial<StaffAvailability> = {}): StaffAvailability {
  return {
    membershipId: 'amy',
    name: 'Amy',
    shiftStartMin: 9 * 60,      // 09:00
    shiftEndMin: 17 * 60,       // 17:00
    busy: [],
    maxConcurrent: 1,
    ...over,
  };
}

const base = {
  businessDate: DATE,
  timezone: TZ,
  openMin: 9 * 60,
  closeMin: 19 * 60,
  durationMin: 60,
  slotMinutes: 15,
  toInstant,
};

describe('findOpenSlots', () => {
  it('空班表：从上班那一刻开始，按粒度排', () => {
    const out = findOpenSlots({ ...base, staff: [staff()], limit: 3 });
    expect(out.map((s) => s.startMin)).toEqual([540, 555, 570]); // 9:00 / 9:15 / 9:30
    expect(out[0]!.startsAt).toEqual(at(540));
    expect(out[0]!.endsAt).toEqual(at(600));
  });

  it('⭐ 整段必须落在班次内 —— 跨过下班时间的单是让技师加班', () => {
    // 技师 17:00 下班，做 60 分钟的活，最晚只能 16:00 开始
    const out = findOpenSlots({ ...base, staff: [staff()], limit: 50 });
    expect(Math.max(...out.map((s) => s.startMin))).toBe(16 * 60);
  });

  it('⭐ 已占用的时段不报 —— 不然两个客人同一时刻被派给同一个人', () => {
    const out = findOpenSlots({
      ...base, limit: 50,
      staff: [staff({ busy: [{ startsAt: at(600), endsAt: at(660) }] })],  // 10:00–11:00
    });
    const starts = out.map((s) => s.startMin);
    // 09:15 起做到 10:15 会撞上，09:00 起做到 10:00 刚好贴边不算撞
    expect(starts).toContain(540);
    expect(starts).not.toContain(555);
    expect(starts).not.toContain(600);
    expect(starts).toContain(660);   // 11:00 接得上
  });

  it('并发上限 2 的技师，同一时段能再压一单', () => {
    // 美甲店：做手的时候脚在泡水
    const out = findOpenSlots({
      ...base, limit: 5,
      staff: [staff({ maxConcurrent: 2, busy: [{ startsAt: at(540), endsAt: at(600) }] })],
    });
    expect(out.map((s) => s.startMin)).toContain(540);
  });

  it('⭐ 客人点名要谁，就只在这个人身上找', () => {
    const out = findOpenSlots({
      ...base, limit: 10, preferredMembershipId: 'linh',
      staff: [staff(), staff({ membershipId: 'linh', name: 'Linh', shiftStartMin: 13 * 60 })],
    });
    expect(out.every((s) => s.membershipId === 'linh')).toBe(true);
    expect(out[0]!.startMin).toBe(13 * 60);   // Linh 下午才上班
  });

  it('时间窗与营业时间取交集 —— 客人说「上午」而店里十点才开门就从十点起', () => {
    const out = findOpenSlots({
      ...base, openMin: 10 * 60, staff: [staff({ shiftStartMin: 10 * 60 })],
      windowStartMin: 8 * 60, windowEndMin: 12 * 60, limit: 1,
    });
    expect(out[0]!.startMin).toBe(10 * 60);
  });

  it('⭐ 不报「现在」之前的空档 —— 客人打电话时已经下午两点了', () => {
    const out = findOpenSlots({ ...base, staff: [staff()], nowMin: 14 * 60 + 5, limit: 1 });
    expect(out[0]!.startMin).toBe(14 * 60 + 15);   // 对齐到下一个格子
  });

  it('起点对齐到粒度 —— 报「14:07 有空」前台还得心算改回整点', () => {
    const out = findOpenSlots({
      ...base, staff: [staff()], nowMin: 601, slotMinutes: 30, limit: 1,
    });
    expect(out[0]!.startMin % 30).toBe(0);
  });

  it('窗口比时长还窄 → 一个都不报，而不是硬塞一个', () => {
    expect(findOpenSlots({
      ...base, staff: [staff()], windowStartMin: 16 * 60, windowEndMin: 16 * 60 + 30,
    })).toEqual([]);
  });

  it('没人在班 / 时长为 0 → 空数组', () => {
    expect(findOpenSlots({ ...base, staff: [] })).toEqual([]);
    expect(findOpenSlots({ ...base, staff: [staff()], durationMin: 0 })).toEqual([]);
  });

  it('同一时刻多个技师有空 → 每人各一条，上层自己决定要不要合并', () => {
    const out = findOpenSlots({
      ...base, limit: 2,
      staff: [staff(), staff({ membershipId: 'linh', name: 'Linh' })],
    });
    expect(out).toHaveLength(2);
    expect(out.map((s) => s.membershipId)).toEqual(['amy', 'linh']);
    expect(out[0]!.startMin).toBe(out[1]!.startMin);
  });
});

describe('summariseSlots（电话里报的那两三个时间）', () => {
  const slots = findOpenSlots({
    ...base, limit: 100,
    staff: [staff(), staff({ membershipId: 'linh', name: 'Linh' })],
  });

  it('按时刻去重，并列出该时刻有空的人', () => {
    const out = summariseSlots(slots, undefined, 2);
    expect(out).toHaveLength(2);
    expect(out[0]!.staff.map((s) => s.name)).toEqual(['Amy', 'Linh']);
  });

  it('⭐ 优先靠近客人说的时间 —— 说「四点左右」就先报四点', () => {
    const out = summariseSlots(slots, 16 * 60, 3);
    expect(out[0]!.startMin).toBe(16 * 60);
  });

  it('距离一样时取靠前的 —— 晚的空档更容易在复核期间被别人订走', () => {
    const out = summariseSlots(slots, 15 * 60, 2);
    expect(out[0]!.startMin).toBe(15 * 60);
    expect(out[1]!.startMin).toBe(15 * 60 - 15);
  });

  it('不给参考时间就按时间先后', () => {
    expect(summariseSlots(slots, undefined, 3).map((s) => s.startMin))
      .toEqual([540, 555, 570]);
  });
});
