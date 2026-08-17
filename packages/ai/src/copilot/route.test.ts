/**
 * 意图路由测试。
 *
 * 这一层的取舍是不对称的，测试也照着这个不对称写：
 *
 *   · **漏放**（该本地答的走了模型）= 多花一分钱。可以接受。
 *   · **误判**（该走模型的被本地答了）= 前台以为事情办了，其实没办。
 *     **不可以接受。**
 *
 * 所以「带动作词的一律放过去」那几条，比「关键词能命中」那几条重要得多。
 */

import { describe, it, expect } from 'vitest';
import { routeLocally } from './route';
import type { FloorSnapshot } from './snapshot';

const snap: FloorSnapshot = {
  header: {
    clock: '14:32', weekday: 'Sat', shopName: 'Lotus Nails',
    onFloor: 6, roomsFree: 3, roomsTotal: 5,
    queueWaiting: 2, queueLongestWaitMin: 22,
  },
  turn: [
    { name: 'Amy', turns: 1, state: 'working' },
    { name: 'Kim', turns: 0.5, state: 'available' },
    { name: 'Tran', turns: 0, state: 'skipped', note: '不会做 Gel-X' },
    { name: 'Mai', turns: 2, state: 'break', note: 'til 14:45' },
  ],
  now: [{ staffName: 'Amy', customerName: '王太太', serviceName: 'Gel Full Set',
          endsAt: '15:05' }],
  next: [{ startsAt: '15:00', customerName: 'Chen L.', serviceName: 'Deep Tissue',
           durationMin: 60, staffName: 'Mai', isRequest: true }],
  queue: [
    { ticketNumber: 7, name: '张先生', waitedMin: 22, overdue: true },
    { ticketNumber: 8, name: 'Ann', waitedMin: 4 },
  ],
  idle: ['Kim'],
};

describe('本地能答的', () => {
  it('几个人在等', () => {
    const r = routeLocally('几个人在等？', snap);
    expect(r?.intent).toBe('queue_status');
    expect(r?.text).toContain('2 位在等');
    expect(r?.text).toContain('#7 张先生');
  });

  it('⭐ 等超时的要主动点出来 —— 客人不会上来问，他会直接走', () => {
    expect(routeLocally('等位', snap)?.text).toContain('等得比说好的久');
  });

  it('谁有空', () => {
    const r = routeLocally('谁有空', snap);
    expect(r?.intent).toBe('who_is_free');
    expect(r?.text).toContain('下一个轮到 Kim');
  });

  it('⭐ 被跳过和休息的人也要说 —— 否则前台会去派一个派不了的单', () => {
    const t = routeLocally('轮到谁了', snap)?.text ?? '';
    expect(t).toContain('Tran（不会做 Gel-X）');
    expect(t).toContain('Mai（休息中）');
  });

  it('现在谁在做', () => {
    const r = routeLocally('现在谁在做单', snap);
    expect(r?.intent).toBe('now_working');
    expect(r?.text).toContain('Amy 在给 王太太 做 Gel Full Set');
  });

  it('接下来有什么', () => {
    const r = routeLocally('接下来有什么单', snap);
    expect(r?.intent).toBe('next_appointments');
    expect(r?.text).toContain('15:00 Chen L.');
    expect(r?.text).toContain('（点钟）');
  });

  it('英文也认', () => {
    expect(routeLocally('who is free?', snap)?.intent).toBe('who_is_free');
    expect(routeLocally('how many waiting', snap)?.intent).toBe('queue_status');
  });

  it('越南语也认 —— 前台不一定说中文或英文', () => {
    expect(routeLocally('ai đang rảnh', snap)?.intent).toBe('who_is_free');
  });

  it('空队列时说得干脆', () => {
    const r = routeLocally('几个人在等', { ...snap, queue: [] });
    expect(r?.text).toBe('现在没有人在等位。');
  });
});

describe('⭐ 必须放给模型的', () => {
  it('带动作词的绝不本地答 —— 前台会以为单已经挪好了', () => {
    // 这一句命中了「等位」之外的东西吗？不重要 ——
    // 只要它带着「挪」，就必须走模型
    expect(routeLocally('把 Lisa 五点那单挪到六点', snap)).toBeNull();
    expect(routeLocally('谁有空？顺便把王太太的单改到明天', snap)).toBeNull();
    expect(routeLocally('move lisa to 6pm', snap)).toBeNull();
    expect(routeLocally('取消张先生的预约', snap)).toBeNull();
  });

  it('「派给谁」是动作不是问句', () => {
    expect(routeLocally('这个客人派给谁有空的人', snap)).toBeNull();
  });

  it('长句子放过去 —— 那多半带着条件和上下文', () => {
    expect(routeLocally(
      '谁有空啊，客人说她只想找上次那个做得比较轻的师傅，不知道今天在不在', snap)).toBeNull();
  });

  it('⭐ 有歧义的说法不本地答', () => {
    // 「下一个」既可能是「下一个轮到谁」也可能是「下一个预约是什么」
    expect(routeLocally('下一个', snap)).toBeNull();
  });

  it('完全无关的问题放过去', () => {
    expect(routeLocally('今天营业额多少', snap)).toBeNull();
    expect(routeLocally('王太太上次做的什么', snap)).toBeNull();
  });

  it('空输入放过去', () => {
    expect(routeLocally('   ', snap)).toBeNull();
  });
});
