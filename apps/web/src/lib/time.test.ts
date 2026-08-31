/**
 * 时间换算的回归测试。
 *
 * 重点覆盖 DST 切换日：美国东部 3 月第二个周日 02:00 跳到 03:00（该日只有 23 小时，
 * 02:00–03:00 不存在），11 月第一个周日 02:00 退回 01:00（01:00–02:00 出现两次）。
 * 任何基于固定偏移量的时间算法都会在这两天出错，而错误只在一年两天里显现。
 */
import { describe, it, expect } from 'vitest';
import {
  instantToWallMinutes, instantToWallDate, wallMinutesToInstant,
  formatWallTime, shiftDate, businessToday, businessDateAt,
} from './time';

const NY = 'America/New_York';
const LA = 'America/Los_Angeles';

describe('instantToWallMinutes', () => {
  it('按门店时区换算，而非浏览器时区', () => {
    // 同一时刻在东西海岸是不同的墙上时间
    const instant = '2026-08-25T18:30:00.000Z';
    expect(instantToWallMinutes(instant, NY)).toBe(14 * 60 + 30);
    expect(instantToWallMinutes(instant, LA)).toBe(11 * 60 + 30);
  });
});

describe('instantToWallDate', () => {
  it('跨日时返回门店本地日期', () => {
    // UTC 已是 26 日凌晨，但纽约仍是 25 日晚间
    expect(instantToWallDate('2026-08-26T03:30:00.000Z', NY)).toBe('2026-08-25');
  });

  it('UTC 午夜之后纽约仍是前一个营业日', () => {
    expect(instantToWallDate('2026-08-31T00:15:00.000Z', NY)).toBe('2026-08-30');
    expect(shiftDate(instantToWallDate('2026-08-31T00:15:00.000Z', NY), -1)).toBe('2026-08-29');
  });

  it('纽约已跨日时洛杉矶仍是前一个营业日', () => {
    expect(instantToWallDate('2026-08-31T04:30:00.000Z', NY)).toBe('2026-08-31');
    expect(instantToWallDate('2026-08-31T04:30:00.000Z', LA)).toBe('2026-08-30');
    expect(shiftDate(instantToWallDate('2026-08-31T04:30:00.000Z', LA), -1)).toBe('2026-08-29');
  });
});

describe('wallMinutesToInstant', () => {
  it('往返转换保持一致', () => {
    const iso = wallMinutesToInstant('2026-08-25', 14 * 60 + 30, NY);
    expect(instantToWallMinutes(iso, NY)).toBe(14 * 60 + 30);
    expect(instantToWallDate(iso, NY)).toBe('2026-08-25');
  });

  it('营业到次日凌晨：分钟数超过 1440 时落到下一个自然日', () => {
    // 营业日 8/25 的第 1530 分钟 = 8/26 凌晨 01:30
    const iso = wallMinutesToInstant('2026-08-25', 25 * 60 + 30, NY);
    expect(instantToWallDate(iso, NY)).toBe('2026-08-26');
    expect(instantToWallMinutes(iso, NY)).toBe(60 + 30);
  });

  it('DST 春季切换日：跳过的那一小时之后仍然对齐', () => {
    // 2026-03-08 是美国春季切换日，02:00 直接跳到 03:00
    const iso = wallMinutesToInstant('2026-03-08', 10 * 60, NY);
    expect(instantToWallMinutes(iso, NY)).toBe(10 * 60);
    expect(instantToWallDate(iso, NY)).toBe('2026-03-08');
  });

  it('DST 秋季切换日：重复的那一小时之后仍然对齐', () => {
    // 2026-11-01 是美国秋季切换日，02:00 退回 01:00
    const iso = wallMinutesToInstant('2026-11-01', 10 * 60, NY);
    expect(instantToWallMinutes(iso, NY)).toBe(10 * 60);
    expect(instantToWallDate(iso, NY)).toBe('2026-11-01');
  });

  it('DST 切换日的营业时段逐点对齐', () => {
    for (const date of ['2026-03-08', '2026-11-01']) {
      for (let m = 9 * 60; m <= 21 * 60; m += 15) {
        const iso = wallMinutesToInstant(date, m, NY);
        expect(instantToWallMinutes(iso, NY)).toBe(m);
      }
    }
  });

  it('DST 日的营业日分量仍按门店墙上日期，不按 UTC', () => {
    // 春季 02:00 跳到 03:00 之后，纽约墙上仍是 3 月 8 日
    expect(instantToWallDate('2026-03-08T07:30:00.000Z', NY)).toBe('2026-03-08');
    // 秋季 01:00 重复的那一小时仍是 11 月 1 日
    expect(instantToWallDate('2026-11-01T06:30:00.000Z', NY)).toBe('2026-11-01');
  });
});

describe('formatWallTime', () => {
  it('补零并对超过一天的分钟数取模', () => {
    expect(formatWallTime(9 * 60 + 5)).toBe('09:05');
    expect(formatWallTime(25 * 60 + 30)).toBe('01:30');
  });
});

describe('shiftDate', () => {
  it('跨月与跨年', () => {
    expect(shiftDate('2026-08-31', 1)).toBe('2026-09-01');
    expect(shiftDate('2026-01-01', -1)).toBe('2025-12-31');
  });
});


/**
 * ── AUD-13 · 营业日 = 门店时区 + cutoff ──────────────────────────────────────
 *
 * 产品口径：Desk 上一切「今天 / 昨天」都是**营业日**，不是日历日。
 *
 *   America/New_York，cutoff 04:00
 *     2026-08-31 01:30 EDT  → 营业今天 2026-08-30，营业昨天 2026-08-29
 *     2026-08-31 04:00 EDT  → 营业今天 2026-08-31
 *
 * QA-008 只把日期控件从 UTC/浏览器本地改成了门店时区的**日历日**，
 * 于是每天凌晨那几个小时前端和 `GET /v1/desk/day` 的 businessDate 对不上。
 * 下面这些用例钉的就是那个窗口 —— 白天跑什么都看不出来。
 */
describe('AUD-13 · businessToday / businessDateAt', () => {
  const NY_ = 'America/New_York';
  const LA_ = 'America/Los_Angeles';

  // 2026-08-31 01:30 EDT = 05:30Z（EDT = UTC-4）
  const NY_BEFORE_CUTOFF = new Date('2026-08-31T05:30:00.000Z');
  // 2026-08-31 04:00 EDT = 08:00Z —— 正好是 cutoff 那一刻
  const NY_AT_CUTOFF = new Date('2026-08-31T08:00:00.000Z');
  // 2026-08-31 10:00 EDT = 14:00Z
  const NY_AFTER_CUTOFF = new Date('2026-08-31T14:00:00.000Z');

  it('纽约 cutoff 之前：营业今天是前一天', () => {
    expect(businessToday(NY_, '04:00', NY_BEFORE_CUTOFF)).toBe('2026-08-30');
  });

  it('纽约 cutoff 之前：营业昨天是前两天', () => {
    const today = businessToday(NY_, '04:00', NY_BEFORE_CUTOFF);
    expect(shiftDate(today, -1)).toBe('2026-08-29');
  });

  it('纽约 cutoff 那一刻：营业日翻页（边界是闭区间的左端）', () => {
    expect(businessToday(NY_, '04:00', NY_AT_CUTOFF)).toBe('2026-08-31');
  });

  it('纽约 cutoff 之后：营业今天等于日历今天', () => {
    expect(businessToday(NY_, '04:00', NY_AFTER_CUTOFF)).toBe('2026-08-31');
  });

  it('洛杉矶 cutoff 之前：按门店时区判断，不是浏览器时区', () => {
    // 同一时刻 05:30Z：纽约 01:30（未过 4 点），洛杉矶 22:30（前一天晚上）
    expect(businessToday(LA_, '04:00', NY_BEFORE_CUTOFF)).toBe('2026-08-30');
    // 2026-08-31 02:00 PDT = 09:00Z —— 洛杉矶自己的凌晨，未过 cutoff
    expect(businessToday(LA_, '04:00', new Date('2026-08-31T09:00:00.000Z'))).toBe('2026-08-30');
    // 2026-08-31 05:00 PDT = 12:00Z —— 过了 cutoff
    expect(businessToday(LA_, '04:00', new Date('2026-08-31T12:00:00.000Z'))).toBe('2026-08-31');
  });

  it('两家店同一时刻可以处在不同的营业日', () => {
    // 2026-08-31 05:00 EDT = 09:00Z：纽约已过 4 点，洛杉矶才 02:00
    const at = new Date('2026-08-31T09:00:00.000Z');
    expect(businessToday(NY_, '04:00', at)).toBe('2026-08-31');
    expect(businessToday(LA_, '04:00', at)).toBe('2026-08-30');
  });

  it('cutoff 00:00 退回日历日语义（会话缺字段时的兜底）', () => {
    expect(businessToday(NY_, '00:00', NY_BEFORE_CUTOFF)).toBe('2026-08-31');
  });

  it('cutoff 03:00 与 04:00 在 03:30 那一刻给出不同答案', () => {
    // 2026-08-31 03:30 EDT = 07:30Z
    const at = new Date('2026-08-31T07:30:00.000Z');
    expect(businessToday(NY_, '03:00', at)).toBe('2026-08-31');
    expect(businessToday(NY_, '04:00', at)).toBe('2026-08-30');
  });

  /**
   * DST。春季那天 02:00 直接跳到 03:00 —— **02:00–03:00 不存在**，
   * 所以 cutoff 设在 02:30 的店那天没有「营业日开始的那一刻」。
   * 秋季那天 01:00–02:00 出现两次。
   * 这两天不写测试，错了要等半年才会再犯一次（宪法第 8 条）。
   */
  describe('DST 边界', () => {
    it('春季前跳日：跳过的一小时前后营业日仍然连续', () => {
      // 2026-03-08 美国春季切换。01:30 EST = 06:30Z，未过 4 点 → 前一天
      expect(businessToday(NY_, '04:00', new Date('2026-03-08T06:30:00.000Z'))).toBe('2026-03-07');
      // 03:30 EDT = 07:30Z（跳过 02:00–03:00 之后），已过 4 点？没有 —— 03:30 < 04:00
      expect(businessToday(NY_, '04:00', new Date('2026-03-08T07:30:00.000Z'))).toBe('2026-03-07');
      // 04:30 EDT = 08:30Z → 翻页
      expect(businessToday(NY_, '04:00', new Date('2026-03-08T08:30:00.000Z'))).toBe('2026-03-08');
    });

    it('春季那天 cutoff 落在不存在的那一小时里，营业日仍然只翻一次页', () => {
      // cutoff 02:30 那天根本不存在。01:59 EST = 06:59Z 仍属前一天；
      // 03:00 EDT = 07:00Z 已经越过 02:30，属当天。中间没有第三种答案。
      expect(businessToday(NY_, '02:30', new Date('2026-03-08T06:59:00.000Z'))).toBe('2026-03-07');
      expect(businessToday(NY_, '02:30', new Date('2026-03-08T07:00:00.000Z'))).toBe('2026-03-08');
    });

    it('秋季回拨日：重复的那一小时两次都算同一个营业日', () => {
      // 2026-11-01。01:30 EDT = 05:30Z（第一次）
      expect(businessToday(NY_, '04:00', new Date('2026-11-01T05:30:00.000Z'))).toBe('2026-10-31');
      // 01:30 EST = 06:30Z（第二次，同一个墙上时间）
      expect(businessToday(NY_, '04:00', new Date('2026-11-01T06:30:00.000Z'))).toBe('2026-10-31');
      // 04:30 EST = 09:30Z → 翻页
      expect(businessToday(NY_, '04:00', new Date('2026-11-01T09:30:00.000Z'))).toBe('2026-11-01');
    });

    it('秋季回拨日的营业日恰好有 25 小时，两端都对', () => {
      // 10-31 的营业日从 10-31 04:00 EDT 开始，到 11-01 04:00 EST 结束
      expect(businessToday(NY_, '04:00', new Date('2026-10-31T08:00:00.000Z'))).toBe('2026-10-31');
      expect(businessToday(NY_, '04:00', new Date('2026-11-01T08:59:00.000Z'))).toBe('2026-10-31');
      expect(businessToday(NY_, '04:00', new Date('2026-11-01T09:00:00.000Z'))).toBe('2026-11-01');
    });
  });

  it('businessDateAt：任意时刻归属哪个营业日', () => {
    // 打烊后 01:15 收的那一单，属于昨晚那一场生意
    expect(businessDateAt('2026-08-31T05:15:00.000Z', NY_, '04:00')).toBe('2026-08-30');
    // 中午的那一单属于当天
    expect(businessDateAt('2026-08-31T16:00:00.000Z', NY_, '04:00')).toBe('2026-08-31');
  });

  it('和服务端同一份实现 —— 前后端不会在 DST 那两天分叉', async () => {
    const { businessDateOf } = await import('@gf/scheduling');
    for (const at of [
      '2026-08-31T05:30:00.000Z', '2026-03-08T07:30:00.000Z', '2026-11-01T06:30:00.000Z',
    ]) {
      expect(businessToday(NY_, '04:00', new Date(at)))
        .toBe(businessDateOf(new Date(at), NY_, '04:00'));
    }
  });
});
