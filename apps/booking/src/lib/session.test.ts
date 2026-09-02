import { describe, expect, it } from 'vitest';
import { loadLastBooking, saveLastBooking } from './session';

describe('same-session success data', () => {
  it('stores only booking id, confirmation code, token, and slug', () => {
    saveLastBooking({
      bookingId: 'appt-1',
      confirmationCode: 'LN-4K2P',
      manageToken: 'mt_abc',
      shopSlug: 'lotus-nails',
    });
    expect(loadLastBooking()).toEqual({
      bookingId: 'appt-1',
      confirmationCode: 'LN-4K2P',
      manageToken: 'mt_abc',
      shopSlug: 'lotus-nails',
    });
    expect(sessionStorage.getItem('gf:last-booking')).not.toMatch(/phone|email|Amy/);
  });
});
