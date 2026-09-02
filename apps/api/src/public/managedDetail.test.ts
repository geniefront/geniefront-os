import { describe, expect, it } from 'vitest';
import {
  bookingWindow, guestActions, guestCancelBlockReason, guestRescheduleBlockReason,
} from './managedDetail';

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
    expect(guestCancelBlockReason(booked)).toBeNull();
    expect(guestRescheduleBlockReason(booked)).toBeNull();
  });

  it('blocks mutations on cancelled, completed, and no_show', () => {
    for (const status of ['cancelled', 'completed', 'no_show']) {
      const a = guestActions({ ...booked, status });
      expect(a.canReschedule).toBe(false);
      expect(a.canCancel).toBe(false);
      expect(a.canRebook).toBe(true);
      expect(a.reason).toBe('not_mutable');
    }
    expect(guestCancelBlockReason({ ...booked, status: 'cancelled' })).toBeNull();
    expect(guestRescheduleBlockReason({ ...booked, status: 'cancelled' }))
      .toBe('already_cancelled');
    expect(guestCancelBlockReason({ ...booked, status: 'completed' })).toBe('not_mutable');
    expect(guestRescheduleBlockReason({ ...booked, status: 'no_show' })).toBe('not_mutable');
  });

  it('matches cutoff and reschedule-limit reasons to mutation flags', () => {
    const cutoff = guestActions({
      ...booked,
      now: new Date('2099-06-15T16:00:00.000Z'),
    });
    expect(cutoff.canCancel).toBe(false);
    expect(cutoff.canReschedule).toBe(false);
    expect(cutoff.reason).toBe('cutoff_passed');
    expect(guestCancelBlockReason({
      ...booked, now: new Date('2099-06-15T16:00:00.000Z'),
    })).toBe('cancel_cutoff_passed');
    expect(guestRescheduleBlockReason({
      ...booked, now: new Date('2099-06-15T16:00:00.000Z'),
    })).toBe('reschedule_cutoff_passed');

    const limited = guestActions({ ...booked, selfRescheduleCount: 2 });
    expect(limited.canReschedule).toBe(false);
    expect(limited.canCancel).toBe(true);
    expect(limited.reason).toBe('reschedule_limit_reached');
    expect(limited.rescheduleCountLeft).toBe(0);

    const disabled = guestActions({ ...booked, rescheduleEnabled: false });
    expect(disabled.canReschedule).toBe(false);
    expect(disabled.canCancel).toBe(true);
    expect(disabled.reason).toBe('reschedule_disabled');

    const unsupported = guestActions({ ...booked, shapeReason: 'shape_unsupported' });
    expect(unsupported.canReschedule).toBe(false);
    expect(unsupported.canCancel).toBe(true);
    expect(unsupported.reason).toBe('shape_unsupported');
  });
});

describe('bookingWindow', () => {
  it('uses the appointment row, not item sequence or summed durations', () => {
    const window = bookingWindow({
      starts_at: '2099-06-15T13:00:00.000Z',
      ends_at: '2099-06-15T14:00:00.000Z',
    });
    expect(window).toEqual({
      startsAt: '2099-06-15T13:00:00.000Z',
      endsAt: '2099-06-15T14:00:00.000Z',
      durationMin: 60,
    });
  });

  it('does not substitute the current time when the window is empty-looking', () => {
    const window = bookingWindow({
      starts_at: '2099-01-01T00:00:00.000Z',
      ends_at: '2099-01-01T00:00:00.000Z',
    });
    expect(window.startsAt).toBe('2099-01-01T00:00:00.000Z');
    expect(window.endsAt).toBe('2099-01-01T00:00:00.000Z');
    expect(window.durationMin).toBe(0);
    expect(window.startsAt).not.toBe(new Date().toISOString());
  });
});
