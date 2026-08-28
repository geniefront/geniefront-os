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
  formatWallTime, shiftDate,
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
