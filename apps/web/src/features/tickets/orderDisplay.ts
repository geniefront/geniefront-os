/**
 * 订单列表的支付方式与退款默认额。
 *
 * 没有收款记录时不得默认「信用卡 (*4242)」——那是演示卡号，待收银单会看起来已经刷过卡。
 * 「全额退款」默认实收总额（含小费），小费不是另起一笔才算全额。
 */

export type OrderPaymentMethod = 'unpaid' | 'card' | 'cash' | 'gift_card' | 'mixed' | 'package' | 'credit_card';

export function orderPaymentDisplay(input: {
  status: string;
  payments: Array<{ method: string; cardLast4?: string | null }>;
}): { method: OrderPaymentMethod; last4: string | null } {
  const payments = input.payments.filter(Boolean);
  if (payments.length === 0) {
    return { method: 'unpaid', last4: null };
  }
  const methods = new Set(payments.map((p) => p.method === 'credit_card' ? 'card' : p.method));
  if (methods.size > 1) return { method: 'mixed', last4: null };
  const first = payments[0]!;
  const raw = first.method === 'credit_card' ? 'card' : first.method;
  const method: OrderPaymentMethod =
    raw === 'card' || raw === 'cash' || raw === 'gift_card' || raw === 'package'
      ? raw
      : 'card';
  return { method, last4: first.cardLast4 ?? null };
}

export function fullRefundCents(input: {
  totalPaidCents: number;
  tipCents: number;
  refundCents: number;
}): number {
  return Math.max(0, input.totalPaidCents - input.refundCents);
}
