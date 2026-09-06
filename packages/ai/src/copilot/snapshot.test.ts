/**
 * 快照格式化测试。
 *
 * 每一条都在问：**模型看到这一行，会不会得出一个错误的结论？**
 *
 * 这里最贵的错不是「格式难看」，是「信息缺了一块而模型不知道自己缺了」——
 * 比如看到 Tran 在轮牌里就以为可以派单给她，而她被跳过是因为不会做 Gel-X。
 */

import { describe, it, expect } from 'vitest';
import {
  formatFloorSnapshot, roughTokens, CONTEXT_TOKEN_BUDGETS, type FloorSnapshot,
} from './snapshot';

const base: FloorSnapshot = {
  header: {
    clock: '14:32', weekday: 'Sat', shopName: 'Lotus Nails',
    onFloor: 6, roomsFree: 3, roomsTotal: 5,
    queueWaiting: 2, queueLongestWaitMin: 20,
  },
  turn: [
    { name: 'Amy', turns: 1, state: 'working' },
    { name: 'Linh', turns: 1, state: 'working' },
    { name: 'Kim', turns: 0.5, state: 'available' },
    { name: 'Tran', turns: 0, state: 'skipped', note: 'no-gelx', owed: true },
    { name: 'Mai', turns: 2, state: 'break', note: 'til 14:45' },
  ],
  now: [
    { staffName: 'Amy', customerName: '王太太', serviceName: 'Gel Full Set', endsAt: '15:05' },
    { staffName: 'Linh', customerName: 'Chen L.', serviceName: 'Pedi', endsAt: '14:50' },
  ],
  next: [
    { startsAt: '15:00', customerName: 'Chen L.', serviceName: 'Deep Tissue',
      durationMin: 60, staffName: 'Mai', isRequest: true,
      details: '[force:4/5 focus:neck AVOID:lwr-back]' },
  ],
  queue: [
    { ticketNumber: 7, name: '张先生', waitedMin: 22, overdue: true, wants: 'pedicure' },
    { ticketNumber: 8, name: 'Walk-in', waitedMin: 4 },
  ],
  idle: ['Kim'],
};

describe('抬头', () => {
  it('一行给全「现在是什么局面」', () => {
    const out = formatFloorSnapshot(base);
    expect(out.split('\n')[0]).toBe(
      '14:32 Sat | Lotus Nails | 6 tech on floor | 3/5 rooms free '
      + '| queue: 2 waiting (longest ~20m)');
  });

  it('没人等位时说 empty，而不是 0 waiting', () => {
    const out = formatFloorSnapshot({
      ...base,
      header: { ...base.header, queueWaiting: 0, queueLongestWaitMin: 0 },
      queue: [],
    });
    expect(out).toContain('queue: empty');
  });
});

describe('轮牌行', () => {
  it('⭐ 被跳过的人必须带原因 —— 否则模型会把 Gel-X 的单派给不会做的人', () => {
    const out = formatFloorSnapshot(base);
    expect(out).toContain('Tran[skip:no-gelx]');
  });

  it('⭐ 欠一轮要标出来 —— 那是「下次优先」的依据', () => {
    expect(formatFloorSnapshot(base)).toContain('Tran[skip:no-gelx]+owed');
  });

  it('休息中带回来的时间 —— 「Mai 有空吗」的答案取决于这个', () => {
    expect(formatFloorSnapshot(base)).toContain('Mai[break til 14:45]');
  });

  it('在做单的人标 busy，不会被当成有空', () => {
    expect(formatFloorSnapshot(base)).toContain('Amy(1.0)[busy]');
  });

  it('轮次用一位小数 —— 0.5 轮是真实存在的（小单算半轮）', () => {
    expect(formatFloorSnapshot(base)).toContain('Kim(0.5)');
  });
});

describe('NOW / NEXT / WAIT', () => {
  it('在做的单带做完时间，空着的人单独列', () => {
    const out = formatFloorSnapshot(base);
    expect(out).toContain('Amy→王太太 Gel Full Set (ends 15:05)');
    expect(out).toContain('idle: Kim');
  });

  it('⭐ 落单要素原样带过来 —— 「避开腰部」漏掉是会出事的那一类', () => {
    expect(formatFloorSnapshot(base)).toContain('AVOID:lwr-back');
  });

  it('点钟单标出来', () => {
    expect(formatFloorSnapshot(base)).toContain('w/ Mai [request]');
  });

  it('还没派技师的预约说清楚，不留空', () => {
    const out = formatFloorSnapshot({
      ...base,
      next: [{ startsAt: '16:00', customerName: 'Ann', serviceName: 'Mani',
               durationMin: 30, staffName: null }],
    });
    expect(out).toContain('[no staff yet]');
  });

  it('⭐ 等超时的带感叹号 —— 客人不会自己上来问，他会直接走', () => {
    expect(formatFloorSnapshot(base)).toContain('#7 张先生 22m!');
  });

  it('空的段整段省掉，不写 NOW: (none)', () => {
    const out = formatFloorSnapshot({
      ...base, now: [], idle: [], next: [], queue: [],
    });
    expect(out).not.toContain('NOW:');
    expect(out).not.toContain('NEXT:');
    expect(out).not.toContain('WAIT:');
  });

  it('⭐ 截断时说清楚还有多少条 —— 不然模型会以为今天就这几单', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      startsAt: `1${i}:00`, customerName: `C${i}`, serviceName: 'Mani',
      durationMin: 30, staffName: 'Amy',
    }));
    const out = formatFloorSnapshot({ ...base, next: many });
    expect(out).toContain('(+4 more later today)');
  });
});

describe('预算', () => {
  it('⭐ 一家忙店的现场快照不该膨胀 —— 这一段只讲「此刻」', () => {
    // 12 个技师、8 个在做、20 条预约、10 个等位 —— 比真实的忙店还夸张
    const busy: FloorSnapshot = {
      header: { ...base.header, onFloor: 12, queueWaiting: 10 },
      turn: Array.from({ length: 12 }, (_, i) => ({
        name: `Tech${i}`, turns: i / 2, state: i % 3 === 0 ? 'working' : 'available',
      })),
      now: Array.from({ length: 8 }, (_, i) => ({
        staffName: `Tech${i}`, customerName: `顾客${i}`,
        serviceName: 'Deluxe Pedicure with Callus', endsAt: '15:05',
      })),
      next: Array.from({ length: 20 }, (_, i) => ({
        startsAt: `1${i % 10}:00`, customerName: `预约客${i}`,
        serviceName: 'Deep Tissue Massage', durationMin: 60, staffName: 'Mai',
      })),
      queue: Array.from({ length: 10 }, (_, i) => ({
        ticketNumber: i, name: `等位${i}`, waitedMin: i * 3,
      })),
      idle: ['A', 'B', 'C'],
    };
    const out = formatFloorSnapshot(busy);
    expect(roughTokens(out)).toBeLessThan(CONTEXT_TOKEN_BUDGETS.FLOOR_SNAPSHOT);
  });

  it('普通一天的快照小得多', () => {
    expect(roughTokens(formatFloorSnapshot(base))).toBeLessThan(300);
  });
});
