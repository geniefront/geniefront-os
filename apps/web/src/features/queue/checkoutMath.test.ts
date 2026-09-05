import { describe, expect, it } from 'vitest';
import {
  buildCheckoutStaffList,
  computeCheckoutTotals,
  UNRESOLVED_STAFF_KEY,
  type CheckoutStaffShare,
} from './checkoutMath';
import type { TicketSummary } from '@/features/tickets/types';

const ticket = (items: Array<{ membershipId: string; staffName: string; name: string; totalCents: number }>): TicketSummary => ({
  ticketId: 't1',
  appointmentId: null,
  status: 'ready_to_pay',
  customerName: 'Guest',
  subtotalCents: items.reduce((sum, item) => sum + item.totalCents, 0),
  groupId: null,
  groupLabel: null,
  businessDate: '2026-09-04',
  daysAgo: 0,
  items: items.map((item, index) => ({
    ticketItemId: `ti-${index}`,
    name: item.name,
    totalCents: item.totalCents,
    durationMin: 60,
    startedAt: null,
    finishedAt: null,
    staffName: item.staffName,
    membershipId: item.membershipId,
  })),
});

const base = {
  baseCents: 10_000,
  discountDollars: '0',
  enableTax: false,
  taxRatePercent: '8.875',
  enableCardSurcharge: false,
  cardSurchargePercent: '3.0',
  paymentMethod: 'card' as const,
  tipMode: 'total_split' as const,
  tipPercentage: 20,
  totalTipDollars: '',
  splitStrategy: 'proportional' as const,
  customStaffTips: {},
};

describe('buildCheckoutStaffList', () => {
  it('归并时用 membershipId 而非姓名，同名技师不会被算成一个人', () => {
    const list = buildCheckoutStaffList(
      {
        serviceName: 'Deep Tissue',
        priceCents: 16_000,
        rawTicket: ticket([
          { membershipId: 'm-1', staffName: 'Bo', name: 'Deep Tissue', totalCents: 8_000 },
          { membershipId: 'm-2', staffName: 'Bo', name: 'Foot Reflexology', totalCents: 8_000 },
        ]),
      },
      'Lead',
      (name) => `+ ${name}`,
    );
    expect(list).toHaveLength(2);
    expect(list.map((entry) => entry.membershipId)).toEqual(['m-1', 'm-2']);
  });

  it('尚未开单时退回预约信息，加项挂到各自的提成技师名下', () => {
    const list = buildCheckoutStaffList(
      {
        serviceName: 'Swedish',
        priceCents: 12_000,
        staffId: 'm-1',
        staffName: 'Bo',
        addOns: [{ name: 'Hot Stone', priceCents: 2_000, staffId: 'm-2', staffName: 'Hua' }],
      },
      'Lead',
      (name) => `+ ${name}`,
    );
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ membershipId: 'm-1', totalRevenueCents: 10_000 });
    expect(list[1]).toMatchObject({ membershipId: 'm-2', totalRevenueCents: 2_000 });
    expect(list[1]?.items[0]?.name).toBe('+ Hot Stone');
  });

  it('归属不明的条目落到占位键上，账面仍然对得平', () => {
    const list = buildCheckoutStaffList(
      { serviceName: 'Walk-in', priceCents: 5_000 },
      'Lead',
      (name) => name,
    );
    expect(list[0]?.membershipId).toBe(UNRESOLVED_STAFF_KEY);
    expect(list[0]?.name).toBe('Lead');
  });
});

describe('computeCheckoutTotals', () => {
  const two: CheckoutStaffShare[] = [
    { membershipId: 'm-1', name: 'Bo', items: [], totalRevenueCents: 7_000 },
    { membershipId: 'm-2', name: 'Hua', items: [], totalRevenueCents: 3_000 },
  ];

  it('按服务营收比例分账，且各行之和恰好等于小费总额', () => {
    const totals = computeCheckoutTotals({ ...base, staffList: two });
    expect(totals.totalTipCents).toBe(2_000);
    expect(totals.tipAllocations.map((entry) => entry.allocatedTipCents)).toEqual([1_400, 600]);
    expect(totals.tipAllocations.reduce((sum, entry) => sum + entry.allocatedTipCents, 0)).toBe(2_000);
  });

  it('除不尽时用最大余额法补齐，不会多出或少掉一分钱', () => {
    const three: CheckoutStaffShare[] = [
      { membershipId: 'a', name: 'A', items: [], totalRevenueCents: 1 },
      { membershipId: 'b', name: 'B', items: [], totalRevenueCents: 1 },
      { membershipId: 'c', name: 'C', items: [], totalRevenueCents: 1 },
    ];
    const totals = computeCheckoutTotals({
      ...base, staffList: three, totalTipDollars: '10.00', splitStrategy: 'equal',
    });
    expect(totals.totalTipCents).toBe(1_000);
    expect(totals.tipAllocations.reduce((sum, entry) => sum + entry.allocatedTipCents, 0)).toBe(1_000);
    expect(totals.tipAllocations.map((entry) => entry.allocatedTipCents)).toEqual([334, 333, 333]);
  });

  it('刷卡附加费只按服务与税额计收，不含小费', () => {
    const totals = computeCheckoutTotals({
      ...base,
      staffList: two,
      enableTax: true,
      enableCardSurcharge: true,
      cardSurchargePercent: '3.0',
    });
    // 10000 服务 + 888 税 = 10888，3% = 327；把 2000 小费计入基数会变成 387
    expect(totals.taxCents).toBe(888);
    expect(totals.cardSurchargeCents).toBe(327);
    expect(totals.totalDueCents).toBe(11_215);
    expect(totals.chargedTotalCents).toBe(13_215);
  });

  it('现金支付不收刷卡附加费', () => {
    const totals = computeCheckoutTotals({
      ...base, staffList: two, paymentMethod: 'cash', enableCardSurcharge: true,
    });
    expect(totals.cardSurchargeCents).toBe(0);
  });

  it('按技师录入时，分账键是 membershipId', () => {
    const totals = computeCheckoutTotals({
      ...base,
      staffList: two,
      tipMode: 'custom_per_staff',
      customStaffTips: { 'm-1': '12.00', 'm-2': '8.00' },
    });
    expect(totals.totalTipCents).toBe(2_000);
    expect(totals.tipAllocations.map((entry) => entry.allocatedTipCents)).toEqual([1_200, 800]);
  });

  it('折扣先于税额生效，且不会把应收压成负数', () => {
    const totals = computeCheckoutTotals({
      ...base, staffList: two, discountDollars: '150.00', enableTax: true, tipPercentage: 0,
    });
    expect(totals.afterDiscountCents).toBe(0);
    expect(totals.taxCents).toBe(0);
    expect(totals.totalDueCents).toBe(0);
  });
});
