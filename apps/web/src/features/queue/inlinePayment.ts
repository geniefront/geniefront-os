/**
 * Queue inline checkout uses the same gift-card contract as `/checkout`:
 * `ticket.pay` requires `giftCardCode` or `giftCardId` when method is gift_card.
 */
export type InlinePayMethod = 'card' | 'cash' | 'gift_card' | 'apple_pay';

export type InlineGiftCardFields = {
  giftCardCode: string;
  giftCardId?: string;
  giftCardVerified: boolean;
  giftCardBalanceCents: number;
};

export type InlineGiftCardResult =
  | { ok: true; giftCardId?: string; giftCardCode?: string }
  | { ok: false; reason: 'missing_gift_card' | 'overspend' };

export function inlineGiftCardFields(
  paymentMethod: InlinePayMethod,
  fields: InlineGiftCardFields,
  chargedCents: number,
): InlineGiftCardResult {
  if (paymentMethod !== 'gift_card') return { ok: true };

  const giftCardCode = fields.giftCardCode.trim();
  const giftCardId = fields.giftCardId?.trim();
  if (!giftCardCode && !giftCardId) {
    return { ok: false, reason: 'missing_gift_card' };
  }
  if (fields.giftCardVerified && chargedCents > fields.giftCardBalanceCents) {
    return { ok: false, reason: 'overspend' };
  }
  return {
    ok: true,
    ...(giftCardId ? { giftCardId } : {}),
    ...(giftCardCode ? { giftCardCode } : {}),
  };
}
