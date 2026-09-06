import { describe, expect, it } from 'vitest';
import { orderPaymentDisplay, fullRefundCents, ticketStatusI18nKey } from './orderDisplay';

describe('orderPaymentDisplay', () => {
  it('待收银且没有任何收款时不得伪造信用卡 *4242', () => {
    expect(orderPaymentDisplay({
      status: 'open',
      payments: [],
    })).toEqual({ method: 'unpaid', last4: null });
  });

  it('有刷卡记录才带卡号后四位', () => {
    expect(orderPaymentDisplay({
      status: 'closed',
      payments: [{ method: 'card', cardLast4: '1881' }],
    })).toEqual({ method: 'card', last4: '1881' });
  });

  it('多笔不同渠道才是 mixed', () => {
    expect(orderPaymentDisplay({
      status: 'closed',
      payments: [
        { method: 'card', cardLast4: '4242' },
        { method: 'cash', cardLast4: null },
      ],
    })).toEqual({ method: 'mixed', last4: null });
  });
});

describe('fullRefundCents', () => {
  it('全额退款默认实收总额（含小费），不是把小费拆出去', () => {
    expect(fullRefundCents({
      totalPaidCents: 5175,
      tipCents: 675,
      refundCents: 0,
    })).toBe(5175);
  });

  it('已经退过一部分时只退剩余实收', () => {
    expect(fullRefundCents({
      totalPaidCents: 5175,
      tipCents: 675,
      refundCents: 1000,
    })).toBe(4175);
  });
});

describe('ticketStatusI18nKey', () => {
  it('closed 不是展示文案', () => {
    expect(ticketStatusI18nKey('closed')).toBe('checkout.tkStatusSettled');
    expect(ticketStatusI18nKey('open')).toBe('checkout.tkStatusPending');
    expect(ticketStatusI18nKey('voided')).toBe('checkout.tkStatusVoidedLabel');
    expect(ticketStatusI18nKey('refunded')).toBe('checkout.tkStatusRefundedLabel');
  });
});
