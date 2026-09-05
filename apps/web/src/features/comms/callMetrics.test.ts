import { describe, expect, it } from 'vitest';
import { callDeskMetrics } from './callMetrics';
import type { CallView } from './types';

const call = (partial: Partial<CallView>): CallView => ({
  callId: 'c1',
  fromE164: '+15555550199',
  startedAt: '2026-09-05T20:00:00.000Z',
  durationSeconds: 120,
  outcome: null,
  toolsUsed: [],
  booked: false,
  recordingUrl: null,
  transcript: [],
  ...partial,
});

describe('callDeskMetrics', () => {
  it('0 通来电时全部是 0，不得发明接通率/成单数/工时', () => {
    expect(callDeskMetrics({ calls: [], bookedCount: 0, totalMinutes: 0 })).toEqual({
      inboundCount: 0,
      bookedCount: 0,
      conversionPercent: 0,
      hoursSaved: 0,
    });
  });

  it('用真实通话条数和 bookedCount，不乘以 12 或 +14', () => {
    const calls = [
      call({ callId: 'a', booked: true, durationSeconds: 180 }),
      call({ callId: 'b', booked: false, durationSeconds: 60 }),
    ];
    expect(callDeskMetrics({ calls, bookedCount: 1, totalMinutes: 4 })).toEqual({
      inboundCount: 2,
      bookedCount: 1,
      conversionPercent: 50,
      hoursSaved: 0.1,
    });
  });
});
