import { describe, it, expect } from 'vitest';
import { readBookingPolicy, bookingLimits } from './bookingPolicy';
import { checkCapacity } from './capacity';

describe('booking capacity buffers', () => {
  const at = (h: number) => new Date(`2030-01-01T${String(h).padStart(2, '0')}:00:00Z`);
  const iv = { startsAt: at(10), endsAt: at(11) };
  it('defaults off and fails closed for malformed settings', () => {
    for (const settings of [null, {}, { capacity: { buffer_enabled: 'true', buffer_extra: 999 } }]) {
      expect(bookingLimits(readBookingPolicy(settings), 2, false).locationLimit).toBe(2);
    }
  });
  it('two staff plus one buffer admits the third but not the fourth', () => {
    const p = readBookingPolicy({ capacity: { buffer_enabled: true, buffer_extra: 1 } });
    const limit = bookingLimits(p, 2, false).locationLimit;
    const check = (count: number) => checkCapacity({ proposed: iv, staff: null,
      location: { maxConcurrentPerSlot: limit, onDutyBookableCount: 2, existing: Array(count).fill(iv) } });
    expect(check(2)).toEqual([]);
    expect(check(3)[0]?.code).toBe('LOCATION_OVER_CAPACITY');
  });
  it('normal buffer does not overbook a requested therapist', () => {
    const p = readBookingPolicy({ capacity: { buffer_enabled: true } });
    expect(bookingLimits(p, 2, true)).toEqual({ locationLimit: 2, staffLimit: 1 });
  });
  it('requested buffer works independently and remains bounded', () => {
    const p = readBookingPolicy({ capacity: { request_buffer_enabled: true, request_buffer_extra: 1 } });
    expect(bookingLimits(p, 2, true)).toEqual({ locationLimit: 3, staffLimit: 2 });
    expect(bookingLimits(p, 2, false)).toEqual({ locationLimit: 2, staffLimit: 1 });
  });
  it('a closed staff roster cannot be opened by a buffer', () => {
    const p = readBookingPolicy({ capacity: { buffer_enabled: true } });
    expect(bookingLimits(p, 0, false).locationLimit).toBe(0);
  });
});
