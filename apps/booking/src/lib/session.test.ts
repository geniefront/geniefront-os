import { describe, expect, it } from 'vitest';
import { loadLastBooking, saveLastBooking } from './session';

describe('same-session success data', () => {
  it('stores only booking id, token, and slug', () => {
    saveLastBooking({
      bookingId: 'appt-1',
      manageToken: 'mt_abc',
      shopSlug: 'lotus-nails',
    });
    expect(loadLastBooking()).toEqual({
      bookingId: 'appt-1',
      manageToken: 'mt_abc',
      shopSlug: 'lotus-nails',
    });
    expect(sessionStorage.getItem('gf:last-booking')).not.toMatch(/phone|email|Amy/);
  });
  it('ignores retired fields from an existing session', () => {
    sessionStorage.setItem('gf:last-booking', JSON.stringify({
      bookingId: 'appt-1', manageToken: 'mt_abc', shopSlug: 'lotus-nails',
      confirmationCode: 'LN-4K2P',
    }));
    const booking = loadLastBooking()!;
    expect(booking).toEqual({ bookingId: 'appt-1', manageToken: 'mt_abc', shopSlug: 'lotus-nails' });
    saveLastBooking(booking);
    expect(JSON.parse(sessionStorage.getItem('gf:last-booking')!)).not.toHaveProperty('confirmationCode');
  });
});
