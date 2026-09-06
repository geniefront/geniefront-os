import { describe, expect, it } from 'vitest';
import { completedCardClock } from './completedClock';

describe('completedCardClock', () => {
  it('有实际完工时刻时，按门店时区显示，不用预约结束点', () => {
    // 2026-09-05 15:33 PDT = 22:33 UTC
    expect(completedCardClock({
      completedAt: '2026-09-05T22:33:00.000Z',
      endTime: '20:00',
      timezone: 'America/Los_Angeles',
    })).toBe('15:33');
  });

  it('没有实际完工时刻时才退回预约结束点', () => {
    expect(completedCardClock({
      completedAt: null,
      endTime: '20:00',
      timezone: 'America/Los_Angeles',
    })).toBe('20:00');
  });
});
