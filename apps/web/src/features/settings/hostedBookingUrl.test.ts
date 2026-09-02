import { describe, expect, it } from 'vitest';
import { hostedBookingUrl } from './hostedBookingUrl';

describe('hostedBookingUrl', () => {
  it('copy, open, and QR all use the same canonical URL', () => {
    const url = hostedBookingUrl('https://book.geniefront.com', 'lotus-nails');
    expect(url).toBe('https://book.geniefront.com/lotus-nails');
    expect(hostedBookingUrl('https://book.geniefront.com/', 'lotus-nails')).toBe(url);
  });

  it('does not invent a URL when origin or slug is missing', () => {
    expect(hostedBookingUrl('', 'lotus-nails')).toBeNull();
    expect(hostedBookingUrl('https://book.geniefront.com', '')).toBeNull();
  });
});
