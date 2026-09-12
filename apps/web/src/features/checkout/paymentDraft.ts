import type { PaymentLine, PaymentMethod } from './types';

export interface DraftLine {
  method: PaymentMethod;
  baseCents: number;
  tipCents: number;
  tenderedCents?: number;
  tenderedInput?: string;
  changeCents: number;
  keepChange: boolean;
  giftCardId?: string;
  giftCardCode?: string;
  giftCardBalanceCents?: number;
  giftCardRecipient?: string;
  giftCardVerified?: boolean;
  giftCardError?: string;
}

export function emptyLine(method: PaymentMethod = 'card'): DraftLine {
  return { method, baseCents: 0, tipCents: 0, changeCents: 0, keepChange: false };
}

/** 该笔的实收额 = 服务Amount + 小费，与刷卡机小票一致。 */
export function chargedCents(line: DraftLine): number {
  return line.baseCents + line.tipCents;
}

/** 界面草稿 → 服务端入参。 */
export function toPaymentLine(line: DraftLine): PaymentLine {
  return {
    method: line.method,
    amountCents: chargedCents(line),
    tipCents: line.tipCents,
    changeCents: cashChange(line),
    keepChange: line.keepChange,
    ...(line.tenderedCents !== undefined ? { tenderedCents: line.tenderedCents } : {}),
    ...(line.giftCardId ? { giftCardId: line.giftCardId } : {}),
    ...(line.giftCardCode ? { giftCardCode: line.giftCardCode } : {}),
  };
}

export function cashChange(line: DraftLine): number {
  return line.method === 'cash' && !line.keepChange && line.tenderedCents !== undefined
    ? Math.max(0, line.tenderedCents - chargedCents(line)) : 0;
}

export function patchPayment(line: DraftLine, patch: Partial<DraftLine>): DraftLine {
  const next = { ...line, ...patch };
  if (next.method === 'cash' && next.keepChange && next.tenderedCents !== undefined) {
    next.tipCents = Math.max(0, next.tenderedCents - next.baseCents);
  }
  return { ...next, changeCents: cashChange(next) };
}

export function distributeTip(lines: DraftLine[], cents: number): DraftLine[] {
  return lines.map((line, index) => patchPayment(line, {
    tipCents: index === 0 ? cents : 0, keepChange: false,
  }));
}
