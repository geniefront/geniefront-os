import { describe, it, expect } from 'vitest';
import {
  expandTemplate, shiftNominalMinutes, shiftRealMinutes, totalMinutesByStaff,
  addDays, weekdayOf, minutesToHHMM, hhmmToMinutes, assertShiftBounds,
  wallMinuteToInstant, createWallMinuteResolver, type ShiftTemplateEntry,
} from './roster';

const NY = 'America/New_York';

const tpl = (over: Partial<ShiftTemplateEntry> = {}): ShiftTemplateEntry => ({
  membershipId: 'a', weekday: 1, startMin: 600, endMin: 1140, breakMin: 30, ...over,
});

describe('request-scoped wall time reuse', () => {
  it('keeps DST, overnight and timezone conversions identical to the uncached algorithm', () => {
    const resolve = createWallMinuteResolver();
    for (const zone of [NY, 'America/Los_Angeles', 'Asia/Shanghai']) {
      for (const date of ['2026-03-07', '2026-03-08', '2026-11-01', '2026-11-02']) {
        for (const minute of [0, 90, 150, 600, 1440, 1590, 2880]) {
          expect(resolve(date, zone, minute)).toEqual(wallMinuteToInstant(date, zone, minute));
          expect(resolve(date, zone, minute)).toEqual(wallMinuteToInstant(date, zone, minute));
        }
      }
    }
  });

  it('does not share mutable Date instances between callers', () => {
    const resolve = createWallMinuteResolver();
    resolve('2026-10-05', NY, 600).setTime(0);
    expect(resolve('2026-10-05', NY, 600).toISOString()).toBe('2026-10-05T14:00:00.000Z');
  });
});

describe('日期算术', () => {
  it('跨月跨年正确', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('星期与本机时区无关', () => {
    expect(weekdayOf('2026-08-16')).toBe(0);   // 周日
    expect(weekdayOf('2026-08-17')).toBe(1);
  });

  it('HH:MM 互转', () => {
    expect(minutesToHHMM(600)).toBe('10:00');
    expect(minutesToHHMM(1560)).toBe('02:00');   // 跨夜显示成次日时刻
    expect(hhmmToMinutes('19:30')).toBe(1170);
    expect(() => hhmmToMinutes('7pm')).toThrow();
  });
});

describe('班次合法性', () => {
  it('跨夜必须写成大于 1440，而不是「结束比开始小」', () => {
    expect(() => assertShiftBounds(1080, 120, 0)).toThrow(/跨夜/);
    expect(() => assertShiftBounds(1080, 1560, 0)).not.toThrow();
  });

  it('休息不能吃掉整个班次', () => {
    expect(() => assertShiftBounds(600, 660, 60)).toThrow();
  });

  it('挡住明显录错的超长班', () => {
    expect(() => assertShiftBounds(0, 1_300, 0)).toThrow(/20 小时/);
  });
});

describe('周模板铺开', () => {
  it('只在匹配的星期生成', () => {
    const out = expandTemplate({
      entries: [tpl({ weekday: 1 }), tpl({ membershipId: 'b', weekday: 3 })],
      fromDate: '2026-08-17', days: 7,      // 周一起
    });
    expect(out).toHaveLength(2);
    expect(out[0]!.businessDate).toBe('2026-08-17');
    expect(out[1]!.businessDate).toBe('2026-08-19');
  });

  it('铺两周就出两轮', () => {
    const out = expandTemplate({ entries: [tpl()], fromDate: '2026-08-17', days: 14 });
    expect(out.map((s) => s.businessDate)).toEqual(['2026-08-17', '2026-08-24']);
  });

  it('skipDates 保护前台手工调过的那天 —— 一键铺开不许冲掉人工安排', () => {
    const out = expandTemplate({
      entries: [tpl()], fromDate: '2026-08-17', days: 14, skipDates: ['2026-08-24'],
    });
    expect(out.map((s) => s.businessDate)).toEqual(['2026-08-17']);
  });

  it('模板里有非法班次就整批拒绝，不生成半套班表', () => {
    expect(() => expandTemplate({
      entries: [tpl(), tpl({ startMin: 600, endMin: 500 })],
      fromDate: '2026-08-17', days: 7,
    })).toThrow();
  });

  it('一次最多铺 62 天', () => {
    expect(() => expandTemplate({ entries: [], fromDate: '2026-08-17', days: 90 })).toThrow();
  });
});

describe('工时', () => {
  it('名义工时扣掉无薪餐休', () => {
    expect(shiftNominalMinutes({ startMin: 600, endMin: 1140, breakMin: 30 })).toBe(510);
  });

  // ── 宪法第 8 条：DST 那两天必须有测试 ──────────────────────────────────────
  it('DST 春季：日间班不受影响（跳变发生在凌晨 2 点）', () => {
    const s = { businessDate: '2026-03-08', startMin: 600, endMin: 1140, breakMin: 30 };
    expect(shiftRealMinutes(s, NY)).toBe(510);
  });

  it('DST 春季跨夜班实际少一小时 —— 少算一小时技师会来问', () => {
    // 2026-03-08 02:00 → 03:00，18:00 到次日 02:00 名义 8 小时，实际 7 小时
    const s = { businessDate: '2026-03-07', startMin: 1080, endMin: 1560, breakMin: 0 };
    expect(shiftNominalMinutes(s)).toBe(480);
    expect(shiftRealMinutes(s, NY)).toBe(420);
  });

  it('DST 秋季跨夜班实际多一小时 —— 多算一小时老板永远不会发现', () => {
    // 2026-11-01 02:00 退回 01:00
    const s = { businessDate: '2026-10-31', startMin: 1080, endMin: 1560, breakMin: 0 };
    expect(shiftNominalMinutes(s)).toBe(480);
    expect(shiftRealMinutes(s, NY)).toBe(540);
  });

  it('墙上时间落在不存在的那一小时时，顺延到等价时刻而不是 Invalid Date', () => {
    const d = wallMinuteToInstant('2026-03-08', NY, 2 * 60 + 30);
    expect(Number.isNaN(d.getTime())).toBe(false);
  });

  it('按人汇总工时', () => {
    const shifts = [
      { businessDate: '2026-08-17', membershipId: 'a', startMin: 600, endMin: 1140, breakMin: 30 },
      { businessDate: '2026-08-18', membershipId: 'a', startMin: 600, endMin: 1140, breakMin: 30 },
      { businessDate: '2026-08-18', membershipId: 'b', startMin: 660, endMin: 1080, breakMin: 0 },
    ];
    const m = totalMinutesByStaff(shifts, NY);
    expect(m.get('a')).toBe(1020);
    expect(m.get('b')).toBe(420);
  });
});
