import { describe, expect, it } from 'vitest';
import {
  allocateTips,
  buildCheckoutStaffList,
  computeCheckoutTotals,
  splitItemRevenueAcrossStaff,
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
  checkoutTiming: 'after_service_combined',
  serviceSettledAt: null,
  tipSettledAt: null,
  serviceCompleted: true,
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

/** 一个项目派两位技师时 `/v1/desk/tickets` 返回的那两行：同一个 ticketItemId，各带完整金额。 */
const sharedItemTicket = (): TicketSummary => {
  const one = ticket([{ membershipId: 'm-1', staffName: 'Amy', name: 'Couples Massage', totalCents: 10_001 }]);
  const row = one.items[0]!;
  return { ...one, items: [row, { ...row, membershipId: 'm-2', staffName: 'Bo' }] };
};

describe('buildCheckoutStaffList', () => {
  /*
   * 双人项目此前被记成「A 一百、B 一百」，营收基数凭空翻倍。比例分账的权重
   * 正是按这个基数算的，与单人项目混在同一张单里时分出来的小费就是错的。
   */
  it('把协作项目的金额在同一条项目的技师之间均摊，而不是每人记一份全额', () => {
    const list = buildCheckoutStaffList(
      { serviceName: 'Couples Massage', priceCents: 10_001, rawTicket: sharedItemTicket() },
      'Lead',
      (name) => `+ ${name}`,
    );
    expect(list.map((entry) => entry.totalRevenueCents)).toEqual([5_000, 5_001]);
    // 各行之和恒等于该项目的金额 —— 不留一分钱的对账差异。
    expect(list.reduce((sum, entry) => sum + entry.totalRevenueCents, 0)).toBe(10_001);
  });

  it('协作项目与单人项目同单时，比例分账按真实执行金额而不是翻倍后的基数', () => {
    const shared = sharedItemTicket();
    const solo = ticket([{ membershipId: 'm-1', staffName: 'Amy', name: 'Foot', totalCents: 5_000 }]);
    const merged: TicketSummary = {
      ...shared,
      subtotalCents: 15_001,
      items: [...shared.items, { ...solo.items[0]!, ticketItemId: 'ti-solo' }],
    };
    const list = buildCheckoutStaffList(
      { serviceName: 'Mixed', priceCents: 15_001, rawTicket: merged }, 'Lead', (name) => `+ ${name}`,
    );
    // Amy 拿协作项目的一半加上自己那一项；Bo 只拿协作项目的另一半。
    expect(list.find((entry) => entry.membershipId === 'm-1')!.totalRevenueCents).toBe(10_000);
    expect(list.find((entry) => entry.membershipId === 'm-2')!.totalRevenueCents).toBe(5_001);
  });

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

  it('税额恒按门店税率计收 —— 收银台没有、也不该有「不收税」这个选项', () => {
    const totals = computeCheckoutTotals({
      ...base, staffList: two, tipPercentage: 0,
    });
    expect(totals.taxCents).toBe(888);
  });

  it('折扣先于税额生效，且不会把应收压成负数', () => {
    const totals = computeCheckoutTotals({
      ...base, staffList: two, discountDollars: '150.00', tipPercentage: 0,
    });
    expect(totals.afterDiscountCents).toBe(0);
    expect(totals.taxCents).toBe(0);
    expect(totals.totalDueCents).toBe(0);
  });
});

/*
 * 服务端对 `tipSplits` 的校验是硬拒：`splitTotal !== totalTip` 直接抛
 * PAYMENT_MISMATCH，这一单当场收不了款。所以「各行之和恒等于总额」不是
 * 精度偏好，是一条不能破的不变量 —— 看板与收银台都靠 `allocateTips()` 守它。
 */
describe('allocateTips 的分账之和恒等于小费总额', () => {
  const staffOf = (revenues: number[]): CheckoutStaffShare[] => revenues.map((cents, index) => ({
    membershipId: `m-${index}`, name: `S${index}`, items: [], totalRevenueCents: cents,
  }));

  it.each([
    ['三人平摊 $10 —— 逐人 Math.round 会得到 999', [100, 100, 100], 1_000, 'equal' as const],
    ['三人等营收按比例 $10', [100, 100, 100], 1_000, 'proportional' as const],
    ['七人不等营收的零头', [13, 29, 7, 101, 5, 61, 3], 999, 'proportional' as const],
    ['营收全为零时退回平摊', [0, 0, 0], 100, 'proportional' as const],
    ['单人拿满', [500], 333, 'proportional' as const],
  ])('%s', (_label, revenues, tip, strategy) => {
    const allocated = allocateTips(staffOf(revenues), tip, strategy);
    expect(allocated.reduce((sum, cents) => sum + cents, 0)).toBe(tip);
    expect(allocated.every((cents) => cents >= 0)).toBe(true);
  });

  it('小费为 0 或没有技师时不分配', () => {
    expect(allocateTips(staffOf([100, 100]), 0, 'equal')).toEqual([0, 0]);
    expect(allocateTips([], 500, 'equal')).toEqual([]);
  });
});

describe('splitItemRevenueAcrossStaff', () => {
  it('把协作项目的金额摊给各行，且各行之和等于项目金额', () => {
    const rows = [
      { ticketItemId: 'a', totalCents: 10_001 },
      { ticketItemId: 'a', totalCents: 10_001 },
      { ticketItemId: 'a', totalCents: 10_001 },
      { ticketItemId: 'b', totalCents: 5_000 },
    ];
    const split = splitItemRevenueAcrossStaff(rows);
    expect(split.filter((r) => r.ticketItemId === 'a').map((r) => r.shareCents)).toEqual([3_333, 3_333, 3_335]);
    expect(split.find((r) => r.ticketItemId === 'b')!.shareCents).toBe(5_000);
    expect(split.reduce((sum, r) => sum + r.shareCents, 0)).toBe(15_001);
  });
});

describe('computeCheckoutTotals 的分阶段收款', () => {
  const one: CheckoutStaffShare[] = [
    { membershipId: 'm-1', name: 'Bo', items: [], totalRevenueCents: 10_000 },
  ];

  it('服务款阶段不收小费，即使前台填了金额也归零', () => {
    const totals = computeCheckoutTotals({
      ...base, staffList: one, paymentStage: 'service', totalTipDollars: '20.00',
    });
    expect(totals.totalTipCents).toBe(0);
    expect(totals.tipAllocations.every((entry) => entry.allocatedTipCents === 0)).toBe(true);
    // 实收即「服务 + 税」，不含任何小费。
    expect(totals.chargedTotalCents).toBe(totals.totalDueCents);
  });

  it('服务款阶段按人录入的小费同样归零，分账之和不会与上报总额不符', () => {
    const totals = computeCheckoutTotals({
      ...base,
      staffList: one,
      paymentStage: 'service',
      tipMode: 'custom_per_staff',
      customStaffTips: { 'm-1': '15.00' },
    });
    expect(totals.totalTipCents).toBe(0);
    expect(totals.tipAllocations[0]?.allocatedTipCents).toBe(0);
  });

  it('小费阶段只收小费，折扣、税与刷卡手续费全部锁定为 0', () => {
    const totals = computeCheckoutTotals({
      ...base,
      staffList: one,
      paymentStage: 'tip',
      tipBaseCents: 10_000,
      discountDollars: '5.00',
      enableCardSurcharge: true,
    });
    expect(totals.discountCents).toBe(0);
    expect(totals.afterDiscountCents).toBe(0);
    expect(totals.taxCents).toBe(0);
    expect(totals.cardSurchargeCents).toBe(0);
    // 百分比按原服务金额计算：10000 分的 20% 就是前台按下的那个 20%。
    expect(totals.totalTipCents).toBe(2_000);
    expect(totals.chargedTotalCents).toBe(2_000);
  });

  it('不传阶段时行为与既有一次性结账完全一致', () => {
    const combined = computeCheckoutTotals({ ...base, staffList: one, paymentStage: 'combined' });
    const legacy = computeCheckoutTotals({ ...base, staffList: one });
    expect(combined).toEqual(legacy);
  });
});

/**
 * 外加税 / 内含税。
 *
 * ⚠️ 这里的数字必须与服务端 `apps/api/src/tax.ts` 的 `locationTaxCents` /
 * `checkoutDueCents` 逐分一致。两边算出不同的数，结账会被 `PAYMENT_MISMATCH`
 * 当场挡下 —— 内含税门店此前就是这样，设置页里可选，实际一单也结不了。
 */
describe('computeCheckoutTotals 的两种税制', () => {
  it('外加税：税加在净额之上', () => {
    const totals = computeCheckoutTotals({
      ...base, staffList: [], taxCalculationMode: 'exclusive',
    });
    // 10000 × 8.875% = 887.5 → 888（与服务端同为四舍五入）
    expect(totals.taxCents).toBe(888);
    expect(totals.totalDueCents).toBe(10_888);
  });

  it('内含税：税从标价里拆出来，总额仍是标价', () => {
    const totals = computeCheckoutTotals({
      ...base, baseCents: 10_888, staffList: [], taxCalculationMode: 'inclusive',
    });
    // 与服务端 tax.test.ts 的断言同一组数：10888 含 8.875% → 税 888
    expect(totals.taxCents).toBe(888);
    expect(totals.totalDueCents).toBe(10_888);
  });

  it('缺省按外加税，保持既有门店行为不变', () => {
    const withMode = computeCheckoutTotals({
      ...base, staffList: [], taxCalculationMode: 'exclusive',
    });
    const withoutMode = computeCheckoutTotals({ ...base, staffList: [] });
    expect(withoutMode.totalDueCents).toBe(withMode.totalDueCents);
  });

  it('刷卡附加费按「服务应收」计，内含税下不把税再算一遍', () => {
    const totals = computeCheckoutTotals({
      ...base,
      baseCents: 10_888,
      staffList: [],
      taxCalculationMode: 'inclusive',
      enableCardSurcharge: true,
    });
    // 基数是 10888（已含税），不是 10888 + 888
    expect(totals.cardSurchargeCents).toBe(Math.round(10_888 * 0.03));
  });
});
