import { describe, it, expect } from 'vitest';
import {
  checkBusinessHours, dayWindow, hoursConfigured, wallMinutesOf, weekdayKeyOf,
  type WeeklyHours,
} from './business-hours';

const NY = 'America/New_York';

/** 2026-08-24 是星期一 */
const MON = '2026-08-24';
const SUN = '2026-08-23';

const HOURS: WeeklyHours = {
  mon: { open: '09:30', close: '19:30' },
  tue: { open: '09:30', close: '19:30' },
  // 周日不开门：键干脆不给（`location.saveHours` 允许缺键或给 null，两种都要认）
  sat: { open: '09:00', close: '20:00' },
};

/** 门店墙上时间 → UTC 时刻。八月的纽约是 EDT（UTC−4） */
const nyc = (date: string, hh: number, mm = 0) =>
  new Date(`${date}T${String(hh + 4).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00Z`);

const check = (startsAt: Date, endsAt: Date, window?: { beforeOpenMinutes: number; afterCloseMinutes: number }, businessDate = MON) =>
  checkBusinessHours({ businessDate, timezone: NY, startsAt, endsAt, hours: HOURS, ...(window ? { window } : {}) });

describe('营业日与星期', () => {
  it('用 UTC 正午取星期，不受本机时区影响', () => {
    expect(weekdayKeyOf(MON)).toBe('mon');
    expect(weekdayKeyOf(SUN)).toBe('sun');
  });

  it('墙上分钟按门店时区算，不是按 UTC', () => {
    // 14:00 UTC 在纽约是 10:00
    expect(wallMinutesOf(MON, NY, new Date(`${MON}T14:00:00Z`))).toBe(10 * 60);
  });

  it('跨午夜的时刻落在 ≥1440', () => {
    // 次日凌晨 1:00 纽约 = 05:00 UTC
    expect(wallMinutesOf(MON, NY, new Date('2026-08-25T05:00:00Z'))).toBe(25 * 60);
  });
});

describe('可约窗口', () => {
  it('宽限为 0 时，边界就是营业时间本身', () => {
    expect(dayWindow(MON, HOURS)).toEqual({
      openMin: 570, closeMin: 1170, earliestMin: 570, latestMin: 1170,
    });
  });

  it('宽限往两头各推一段', () => {
    expect(dayWindow(MON, HOURS, { beforeOpenMinutes: 60, afterCloseMinutes: 30 }))
      .toMatchObject({ earliestMin: 510, latestMin: 1200 });
  });

  it('跨午夜：close 比 open 早就加一天，否则窗口是负的', () => {
    const w = dayWindow(MON, { mon: { open: '10:00', close: '01:00' } });
    expect(w).toMatchObject({ openMin: 600, closeMin: 25 * 60 });
  });

  it('那天没有营业时间 → null（不营业）', () => {
    expect(dayWindow(SUN, HOURS)).toBeNull();
    expect(dayWindow(MON, { mon: null })).toBeNull();
  });
});

describe('闸门', () => {
  it('营业时间内放行', () => {
    expect(check(nyc(MON, 10), nyc(MON, 11))).toBeNull();
  });

  it('九点半开门、客人要八点 → BEFORE_OPEN', () => {
    const issue = check(nyc(MON, 8), nyc(MON, 9));
    expect(issue?.code).toBe('BEFORE_OPEN');
    expect(issue?.startMin).toBe(480);
  });

  it('⭐ 老板放开一小时之后，同一个八点就约得进去', () => {
    expect(check(nyc(MON, 8, 30), nyc(MON, 9, 30),
      { beforeOpenMinutes: 60, afterCloseMinutes: 0 })).toBeNull();
  });

  it('宽限只推一小时，八点整还是不行 —— 边界不能顺手多给', () => {
    expect(check(nyc(MON, 8), nyc(MON, 9),
      { beforeOpenMinutes: 60, afterCloseMinutes: 0 })?.code).toBe('BEFORE_OPEN');
  });

  it('看的是结束时刻不是开始时刻：19:00 开始的 60 分钟做到 20:00，超了', () => {
    expect(check(nyc(MON, 19), nyc(MON, 20))?.code).toBe('AFTER_CLOSE');
    expect(check(nyc(MON, 19), nyc(MON, 20),
      { beforeOpenMinutes: 0, afterCloseMinutes: 30 })).toBeNull();
  });

  it('关门那天一律 CLOSED_DAY，宽限不适用（没有可围绕的锚点）', () => {
    const issue = checkBusinessHours({
      businessDate: SUN, timezone: NY, hours: HOURS,
      startsAt: nyc(SUN, 14), endsAt: nyc(SUN, 15),
      window: { beforeOpenMinutes: 240, afterCloseMinutes: 240 },
    });
    expect(issue?.code).toBe('CLOSED_DAY');
    expect(issue?.window).toBeNull();
  });

  it('⭐ 一个键都没有 = 还没配，不设闸门 —— 新店第一单不能被自己挡住', () => {
    expect(hoursConfigured({})).toBe(false);
    expect(checkBusinessHours({
      businessDate: MON, timezone: NY, hours: {},
      startsAt: nyc(MON, 3), endsAt: nyc(MON, 4),
    })).toBeNull();
  });

  it('配了别的天、这天缺键 → 仍然是关门，不是「没配」', () => {
    expect(checkBusinessHours({
      businessDate: SUN, timezone: NY, hours: HOURS,
      startsAt: nyc(SUN, 14), endsAt: nyc(SUN, 15),
    })?.code).toBe('CLOSED_DAY');
  });

  it('跨午夜的店：凌晨 0:30 的单算在营业中，不是「超了」', () => {
    expect(checkBusinessHours({
      businessDate: MON, timezone: NY, hours: { mon: { open: '10:00', close: '01:00' } },
      startsAt: new Date('2026-08-25T04:30:00Z'),   // 纽约 00:30
      endsAt: new Date('2026-08-25T05:00:00Z'),     // 纽约 01:00
    })).toBeNull();
  });

  it('DST 秋令时那天用墙上分钟判，不用真实流逝分钟', () => {
    // 2026-11-01 纽约 02:00 退回 01:00。下午 2 点仍然是墙上 14:00，
    // 若用「距营业日起点流逝了多少分钟」会算成 13:00
    const hours: WeeklyHours = { sun: { open: '10:00', close: '18:00' } };
    expect(wallMinutesOf('2026-11-01', NY, new Date('2026-11-01T19:00:00Z'))).toBe(14 * 60);
    expect(checkBusinessHours({
      businessDate: '2026-11-01', timezone: NY, hours,
      startsAt: new Date('2026-11-01T19:00:00Z'),
      endsAt: new Date('2026-11-01T20:00:00Z'),
    })).toBeNull();
  });
});
