import { describe, expect, it } from 'vitest';
import { guestActions } from './managedDetail';

const booked = {
  status: 'booked',
  startsAt: '2099-06-15T18:00:00.000Z',
  now: new Date('2099-06-15T10:00:00.000Z'),
  cancelCutoffHours: 4,
  rescheduleEnabled: true,
  rescheduleCutoffHours: 4,
  selfRescheduleMax: 2,
  selfRescheduleCount: 0,
};

describe('guestActions', () => {
  it('allows reschedule, cancel, and rebook for a booked appointment inside policy', () => {
    expect(guestActions(booked)).toEqual({
      canReschedule: true,
      canCancel: true,
      canRebook: true,
      reason: null,
      rescheduleCountLeft: 2,
    });
  });

  it('blocks mutations on cancelled, completed, and no_show', () => {
    for (const status of ['cancelled', 'completed', 'no_show']) {
      const a = guestActions({ ...booked, status });
      expect(a.canReschedule).toBe(false);
      expect(a.canCancel).toBe(false);
      expect(a.canRebook).toBe(true);
      expect(a.reason).toBe('not_mutable');
    }
  });

  it('matches cutoff and reschedule-limit reasons to mutation flags', () => {
    const cutoff = guestActions({
      ...booked,
      now: new Date('2099-06-15T16:00:00.000Z'),
    });
    expect(cutoff.canCancel).toBe(false);
    expect(cutoff.canReschedule).toBe(false);
    expect(cutoff.reason).toBe('cutoff_passed');

    const limited = guestActions({ ...booked, selfRescheduleCount: 2 });
    expect(limited.canReschedule).toBe(false);
    expect(limited.canCancel).toBe(true);
    expect(limited.reason).toBe('reschedule_limit_reached');
    expect(limited.rescheduleCountLeft).toBe(0);

    const disabled = guestActions({ ...booked, rescheduleEnabled: false });
    expect(disabled.canReschedule).toBe(false);
    expect(disabled.canCancel).toBe(true);
    expect(disabled.reason).toBe('reschedule_disabled');
  });
});
