import { describe, expect, it } from 'vitest';
import { bookedMessage } from './embed';

describe('embed postMessage', () => {
  it('does not include customer PII or the manage token', () => {
    const msg = bookedMessage('LN-4K2P');
    expect(msg).toEqual({ type: 'gf-booking:booked', confirmationCode: 'LN-4K2P' });
    expect(JSON.stringify(msg)).not.toMatch(/mt_/);
    expect(JSON.stringify(msg)).not.toMatch(/phone|email|name/i);
  });
});
