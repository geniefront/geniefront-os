/**
 * 看板收银弹窗的金额与分账计算。
 *
 * 抽成独立模块的原因很直接：此前弹窗里算一遍给人看、提交处再算一遍发给服务端，
 * 两份代码不一致 —— 界面上的小费分账明细压根没有出口，前台看到的数字与技师
 * 实际拿到的提成对不上。现在渲染与提交共用同一份结果，看到什么就发送什么。
 */
import type { PaymentStage } from '@/features/checkout/types';
import type { TicketSummary } from '@/features/tickets/types';

/** 参与本单的一位技师，及其执行明细。 */
export interface CheckoutStaffShare {
  /** membership UUID。**必须**用它做键：技师重名时按姓名归并会把两个人算成一个。 */
  membershipId: string;
  name: string;
  items: Array<{ name: string; priceCents: number }>;
  totalRevenueCents: number;
}

export interface CheckoutStaffSource {
  serviceName: string;
  priceCents: number;
  staffId?: string | null;
  staffName?: string | null;
  rawTicket?: TicketSummary | undefined;
  addOns?: Array<{ name: string; priceCents: number; staffId: string; staffName?: string }> | undefined;
}

/** 无法确定归属时的占位键。保留一行而不是丢弃，账面上才对得平。 */
export const UNRESOLVED_STAFF_KEY = 'unresolved';

/**
 * 汇总本单的技师执行明细。
 *
 * 已开单时以工单条目为准 —— 那是服务端认的事实，且每条都带 membershipId；
 * 尚未开单（前台直接从看板结账）时退回预约信息拼装。
 */
export function buildCheckoutStaffList(
  source: CheckoutStaffSource,
  fallbackStaffName: string,
  addOnLabel: (name: string) => string,
): CheckoutStaffShare[] {
  const map = new Map<string, CheckoutStaffShare>();
  const push = (membershipId: string, name: string, itemName: string, priceCents: number) => {
    const existing = map.get(membershipId) ?? { membershipId, name, items: [], totalRevenueCents: 0 };
    existing.items.push({ name: itemName, priceCents });
    existing.totalRevenueCents += priceCents;
    if (!existing.name && name) existing.name = name;
    map.set(membershipId, existing);
  };

  /* 协作项目的金额在执行它的技师之间均摊，见 `splitItemRevenueAcrossStaff()`。 */
  const ticketItems = source.rawTicket?.items ?? [];
  if (ticketItems.length > 0) {
    splitItemRevenueAcrossStaff(ticketItems).forEach((ticketItem) => {
      push(
        ticketItem.membershipId || UNRESOLVED_STAFF_KEY,
        ticketItem.staffName || fallbackStaffName,
        ticketItem.name,
        ticketItem.shareCents,
      );
    });
    return [...map.values()];
  }

  const addOns = source.addOns ?? [];
  const addOnTotalCents = addOns.reduce((sum, addOn) => sum + addOn.priceCents, 0);
  const mainStaffId = source.staffId || UNRESOLVED_STAFF_KEY;
  push(
    mainStaffId,
    source.staffName || fallbackStaffName,
    source.serviceName,
    source.priceCents - addOnTotalCents,
  );
  addOns.forEach((addOn) => {
    push(
      addOn.staffId || mainStaffId,
      addOn.staffName || source.staffName || fallbackStaffName,
      addOnLabel(addOn.name),
      addOn.priceCents,
    );
  });
  return [...map.values()];
}

export interface CheckoutTotalsInput {
  staffList: CheckoutStaffShare[];
  baseCents: number;
  discountDollars: string;
  /**
   * 门店税率（百分数字符串）。税额恒按它计收。
   *
   * ⚠️ 这里**没有**「要不要收税」的开关，是刻意的：销售税是法定的，不是收银
   * 台的选项。此前输入里有一个 `enableTax`，而本函数从头到尾没有读过它 ——
   * 收银弹窗上那个勾选框因此只改变「摘要里显不显示税这一行」，钱照收。
   * 前台取消勾选、看着一张不含税的摘要，客人卡上却被多扣了一笔。
   */
  taxRatePercent: string;
  /**
   * 外加税 / 内含税。**必须与服务端同一份门店设置一致。**
   *
   * 此前本函数根本没有这个字段，一律按外加税算。内含税门店因此出现
   * 「界面报的总额」与「服务端算的应收」不相等，每一单都被
   * `PAYMENT_MISMATCH` 挡下 —— 设置页里可选的功能，实际完全不能用。
   */
  taxCalculationMode?: 'exclusive' | 'inclusive';
  enableCardSurcharge: boolean;
  cardSurchargePercent: string;
  paymentMethod: 'card' | 'cash' | 'gift_card' | 'apple_pay';
  tipMode: 'total_split' | 'custom_per_staff';
  tipPercentage: number;
  totalTipDollars: string;
  splitStrategy: 'proportional' | 'equal';
  /** 键为 membershipId。 */
  customStaffTips: Record<string, string>;
  /**
   * 收款阶段。缺省等同 `combined`（一次性收清）。
   *
   * 分阶段收款并非在界面上「少显示几个输入框」那么简单：服务端对
   * `service` 阶段要求小费为 0，对 `tip` 阶段只接受小费金额。若仍按整单
   * 金额计算再提交，必然被判 PAYMENT_MISMATCH。故金额口径在此统一收敛，
   * 渲染与提交共用同一结果。
   */
  paymentStage?: PaymentStage;
  /**
   * 小费百分比的计算基数。
   *
   * 小费阶段的服务金额已经收过，本次应收基数为 0，按 0 取百分比只会得到 0。
   * 因此该阶段必须显式传入原服务金额，前台的「20%」才是客人理解的那个 20%。
   */
  tipBaseCents?: number;
}

export interface CheckoutTipAllocation extends CheckoutStaffShare {
  allocatedTipCents: number;
  percent: number;
}

export interface CheckoutTotals {
  discountCents: number;
  afterDiscountCents: number;
  taxCents: number;
  totalTipCents: number;
  cardSurchargeCents: number;
  /** 服务 + 税 + 手续费，不含小费。 */
  totalDueCents: number;
  /** 实际刷卡/收取的金额，含小费。 */
  chargedTotalCents: number;
  tipAllocations: CheckoutTipAllocation[];
}

const toCents = (dollars: string): number => {
  const parsed = Number.parseFloat(dollars || '0');
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
};

const toRate = (percent: string): number => {
  const parsed = Number.parseFloat(percent || '0');
  return Number.isFinite(parsed) ? parsed / 100 : 0;
};

/**
 * 把一条工单项目的金额摊到执行它的若干位技师头上。
 *
 * `/v1/desk/tickets` 是按 `ticket_item_staff` 展开的：一个项目派了几位技师就
 * 返回几行，**每行都带着该项目的完整金额**。谁直接遍历原始行，谁的营收基数
 * 就会翻倍 —— 而比例分账的权重正是按这个基数算的。看板与收银台都必须走这里。
 *
 * 返回值按 `ticketItemId` 聚合，`shareCents` 是该行技师应记的那一份；尾差补给
 * 同一项目的最后一行，各行之和恒等于该项目的金额。
 */
export function splitItemRevenueAcrossStaff<T extends { ticketItemId: string; totalCents: number }>(
  rows: readonly T[],
): Array<T & { shareCents: number }> {
  const staffCountByItem = new Map<string, number>();
  for (const row of rows) {
    staffCountByItem.set(row.ticketItemId, (staffCountByItem.get(row.ticketItemId) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const shares = staffCountByItem.get(row.ticketItemId) ?? 1;
    const index = seen.get(row.ticketItemId) ?? 0;
    seen.set(row.ticketItemId, index + 1);
    const shareCents = index === shares - 1
      ? row.totalCents - Math.floor(row.totalCents / shares) * (shares - 1)
      : Math.floor(row.totalCents / shares);
    return { ...row, shareCents };
  });
}

/**
 * 把小费总额按策略分到各技师头上。
 *
 * 用最大余额法而不是逐个四舍五入：后者的和可能比总额多一分或少一分 ——
 * 而服务端对 `tipSplits` 的校验是**硬拒**（`splitTotal !== totalTip` 直接抛
 * PAYMENT_MISMATCH），差一分的后果不是对账多一条差异，而是这一单根本收不了款。
 * 三位技师平摊 $10 就是最短的复现路径：round(1000/3)×3 = 999。
 */
export function allocateTips(
  staffList: CheckoutStaffShare[],
  totalTipCents: number,
  strategy: 'proportional' | 'equal',
): number[] {
  if (staffList.length === 0 || totalTipCents <= 0) return staffList.map(() => 0);

  const totalRevenue = staffList.reduce((sum, staff) => sum + staff.totalRevenueCents, 0);
  const weights = strategy === 'equal' || totalRevenue <= 0
    ? staffList.map(() => 1 / staffList.length)
    : staffList.map((staff) => staff.totalRevenueCents / totalRevenue);

  const exact = weights.map((weight) => totalTipCents * weight);
  const floors = exact.map((value) => Math.floor(value));
  let remainder = totalTipCents - floors.reduce((sum, value) => sum + value, 0);

  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction);
  for (const entry of order) {
    if (remainder <= 0) break;
    floors[entry.index] = (floors[entry.index] ?? 0) + 1;
    remainder -= 1;
  }
  return floors;
}

export function computeCheckoutTotals(input: CheckoutTotalsInput): CheckoutTotals {
  const stage = input.paymentStage ?? 'combined';
  /*
   * 小费阶段的服务款已经收过，本次不再重复收取，因此服务基数、折扣、税与
   * 刷卡手续费一律归零 —— 这些字段在界面上也是锁死的，两边必须一致。
   */
  const isTipOnly = stage === 'tip';
  const discountCents = isTipOnly ? 0 : Math.max(0, toCents(input.discountDollars));
  const afterDiscountCents = isTipOnly ? 0 : Math.max(0, input.baseCents - discountCents);
  /*
   * 两种税制下 taxCents 的含义不同：
   *   外加税 —— 税加在净额之上，应收 = 净额 + 税
   *   内含税 —— 标价已含税，税只是从标价里拆出来的那一部分，应收 = 标价
   * 与服务端 `apps/api/src/tax.ts` 的 `locationTaxCents` / `checkoutDueCents`
   * 必须逐分一致，否则结账会被 PAYMENT_MISMATCH 挡下。
   */
  const taxInclusive = input.taxCalculationMode === 'inclusive';
  const taxRate = toRate(input.taxRatePercent);
  const taxCents = isTipOnly
    ? 0
    : taxInclusive
      ? Math.round(afterDiscountCents - afterDiscountCents / (1 + taxRate))
      : Math.round(afterDiscountCents * taxRate);
  /** 服务部分的应收（不含小费与附加费）。内含税时税已在其中。 */
  const serviceDueCents = taxInclusive ? afterDiscountCents : afterDiscountCents + taxCents;

  const tipBaseCents = input.tipBaseCents ?? afterDiscountCents;
  const enteredTipCents = input.tipMode === 'total_split'
    ? (input.totalTipDollars !== ''
        ? Math.max(0, toCents(input.totalTipDollars))
        : Math.round((tipBaseCents * input.tipPercentage) / 100))
    : Object.values(input.customStaffTips).reduce(
        (sum, value) => sum + Math.max(0, toCents(value || '0')),
        0,
      );
  // 服务款阶段服务端要求小费必须为 0，界面上也不提供录入口。
  const totalTipCents = stage === 'service' ? 0 : enteredTipCents;

  /*
   * 刷卡附加费只按「服务 + 税」计收。
   * 多数州禁止对小费部分加收刷卡手续费 —— 把小费算进基数是实打实的合规风险。
   */
  const cardAccepted = input.paymentMethod === 'card' || input.paymentMethod === 'apple_pay';
  const cardSurchargeCents = !isTipOnly && input.enableCardSurcharge && cardAccepted
    ? Math.round(serviceDueCents * toRate(input.cardSurchargePercent))
    : 0;

  // 小费为 0（服务款阶段必然如此）时不得再按人分配，否则分账之和会与上报总额不符。
  const allocated = totalTipCents === 0
    ? input.staffList.map(() => 0)
    : input.tipMode === 'custom_per_staff'
      ? input.staffList.map((staff) => Math.max(0, toCents(input.customStaffTips[staff.membershipId] || '0')))
      : allocateTips(input.staffList, totalTipCents, input.splitStrategy);

  const tipAllocations: CheckoutTipAllocation[] = input.staffList.map((staff, index) => {
    const allocatedTipCents = allocated[index] ?? 0;
    return {
      ...staff,
      allocatedTipCents,
      percent: totalTipCents > 0 ? Math.round((allocatedTipCents / totalTipCents) * 100) : 0,
    };
  });

  const totalDueCents = serviceDueCents + cardSurchargeCents;

  return {
    discountCents,
    afterDiscountCents,
    taxCents,
    totalTipCents,
    cardSurchargeCents,
    totalDueCents,
    chargedTotalCents: totalDueCents + totalTipCents,
    tipAllocations,
  };
}
