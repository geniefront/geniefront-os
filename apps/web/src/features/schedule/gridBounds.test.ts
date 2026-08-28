/**
 * 时间轴范围推导的回归测试。
 *
 * 起因：范围原先写死为 08:00–22:00，而种子数据中存在 05:00 与 07:00 的单据。
 * 这些单据会被裁到视野外 —— 前台看到的日程比实际少，且界面上没有任何迹象
 * 表明有内容被隐藏。这类缺陷在界面上不表现为报错，只表现为「少了几条」，
 * 因此必须由测试锁住。
 */
import { describe, it, expect } from 'vitest';
import { gridBounds } from './gridBounds';

const OPEN = 9 * 60 + 30;   // 09:30
const CLOSE = 19 * 60 + 30; // 19:30

describe('gridBounds', () => {
  it('无单据时以营业时间为准，并向外留出余量', () => {
    const { start, end } = gridBounds(OPEN, CLOSE, []);
    expect(start).toBeLessThanOrEqual(OPEN);
    expect(end).toBeGreaterThanOrEqual(CLOSE);
  });

  it('营业前的单据必须落在范围内', () => {
    const items = [{ startMins: 5 * 60, endMins: 5 * 60 + 45 }];
    const { start, end } = gridBounds(OPEN, CLOSE, items);
    expect(start).toBeLessThanOrEqual(items[0]!.startMins);
    expect(end).toBeGreaterThanOrEqual(items[0]!.endMins);
  });

  it('营业后的单据必须落在范围内', () => {
    const items = [{ startMins: 22 * 60, endMins: 23 * 60 }];
    const { start, end } = gridBounds(OPEN, CLOSE, items);
    expect(end).toBeGreaterThanOrEqual(items[0]!.endMins);
  });

  it('跨午夜营业：分钟数超过 1440 的单据同样不被裁掉', () => {
    // 营业至次日 02:00 的门店，其营业日尾段的分钟数为 1560
    const items = [{ startMins: 25 * 60, endMins: 26 * 60 }];
    const { start, end } = gridBounds(OPEN, 26 * 60, items);
    expect(start).toBeLessThanOrEqual(OPEN);
    expect(end).toBeGreaterThanOrEqual(26 * 60);
  });

  it('范围向外取整到整点，避免出现半小时的行高', () => {
    const { start, end } = gridBounds(OPEN, CLOSE, []);
    expect(start % 60).toBe(0);
    expect(end % 60).toBe(0);
  });

  it('营业时间缺失（新店未配置）时退回兜底范围而非产生 NaN', () => {
    const { start, end } = gridBounds(Number.NaN, Number.NaN, []);
    expect(Number.isFinite(start)).toBe(true);
    expect(Number.isFinite(end)).toBe(true);
    expect(end).toBeGreaterThan(start);
  });
});
