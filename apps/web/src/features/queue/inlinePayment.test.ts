import { describe, expect, it } from 'vitest';
import { inlineGiftCardFields } from './inlinePayment';

describe('inlineGiftCardFields', () => {
  it('passes through non-gift-card methods with no extra fields', () => {
    expect(inlineGiftCardFields('card', {
      giftCardCode: '',
      giftCardVerified: false,
      giftCardBalanceCents: 0,
    }, 5000)).toEqual({ ok: true });
  });

  it('rejects gift-card pay without code or id', () => {
    expect(inlineGiftCardFields('gift_card', {
      giftCardCode: '  ',
      giftCardVerified: false,
      giftCardBalanceCents: 0,
    }, 5000)).toEqual({ ok: false, reason: 'missing_gift_card' });
  });

  it('sends giftCardCode and giftCardId on the canonical ticket.pay line', () => {
    expect(inlineGiftCardFields('gift_card', {
      giftCardCode: 'GC-8839-2026',
      giftCardId: '11111111-1111-1111-1111-111111111111',
      giftCardVerified: true,
      giftCardBalanceCents: 8000,
    }, 5000)).toEqual({
      ok: true,
      giftCardCode: 'GC-8839-2026',
      giftCardId: '11111111-1111-1111-1111-111111111111',
    });
  });

  it('rejects verified cards whose balance cannot cover the charge', () => {
    expect(inlineGiftCardFields('gift_card', {
      giftCardCode: 'GC-1',
      giftCardVerified: true,
      giftCardBalanceCents: 1000,
    }, 5000)).toEqual({ ok: false, reason: 'overspend' });
  });
});
