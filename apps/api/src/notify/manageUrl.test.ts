import { describe, expect, it } from 'vitest';
import { generateManageToken, hashManageToken, wrapManageToken } from '../public/bookingToken';
import { guestManageLink } from './manageUrl';

describe('guestManageLink', () => {
  it('rebuilds the hosted URL from the wrap without rotating the token', () => {
    const prevFlag = process.env['BOOKING_MANAGE_PAGE_ENABLED'];
    const prevOrigin = process.env['BOOKING_PAGE_ORIGIN'];
    process.env['BOOKING_MANAGE_PAGE_ENABLED'] = '1';
    process.env['BOOKING_PAGE_ORIGIN'] = 'https://book.geniefront.com';
    if (!process.env['APP_JWT_SECRET'] || process.env['APP_JWT_SECRET'].length < 32) {
      process.env['APP_JWT_SECRET'] = 'booking-token-wrap-test-secret-at-least-32';
    }
    try {
      const token = generateManageToken();
      const digest = hashManageToken(token);
      const wrapped = wrapManageToken(token)!;
      const url = guestManageLink({ shopSlug: 'lotus-nails', wrapped, digest });
      expect(url).toBe(`https://book.geniefront.com/l/lotus-nails#g/${token}`);
      expect(guestManageLink({ shopSlug: 'lotus-nails', wrapped, digest: hashManageToken('mt_other') }))
        .toBeNull();
      expect(guestManageLink({ shopSlug: 'lotus-nails' })).toBeNull();
    } finally {
      if (prevFlag === undefined) delete process.env['BOOKING_MANAGE_PAGE_ENABLED'];
      else process.env['BOOKING_MANAGE_PAGE_ENABLED'] = prevFlag;
      if (prevOrigin === undefined) delete process.env['BOOKING_PAGE_ORIGIN'];
      else process.env['BOOKING_PAGE_ORIGIN'] = prevOrigin;
    }
  });
});
