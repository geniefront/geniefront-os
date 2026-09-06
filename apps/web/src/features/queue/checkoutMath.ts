/**
 * 看板收银弹窗的金额与分账计算。
 *
 * 抽成独立模块的原因很直接：此前弹窗里算一遍给人看、提交处再算一遍发给服务端，
 * 两份代码不一致 —— 界面上的小费分账明细压根没有出口，前台看到的数字与技师
 * 实际拿到的提成对不上。现在渲染与提交共用同一份结果，看到什么就发送什么。
 */
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

  const ticketItems = source.rawTicket?.items ?? [];
  if (ticketItems.length > 0) {
    ticketItems.forEach((ticketItem) => {
      push(
        ticketItem.membershipId || UNRESOLVED_STAFF_KEY,
        ticketItem.staffName || fallbackStaffName,
        ticketItem.name,
        ticketItem.totalCents,
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
  enableTax: boolean;
  taxRatePercent: string;
  enableCardSurcharge: boolean;
  cardSurchargePercent: string;
  paymentMethod: 'card' | 'cash' | 'gift_card' | 'apple_pay';
  tipMode: 'total_split' | 'custom_per_staff';
  tipPercentage: number;
  totalTipDollars: string;
  splitStrategy: 'proportional' | 'equal';
  /** 键为 membershipId。 */
  customStaffTips: Record<string, string>;
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
 * 把小费总额按策略分到各技师头上。
 *
 * 用最大余额法而不是逐个四舍五入：后者的和可能比总额多一分或少一分，
 * 而这一分会在日结对账时变成一条查不出来源的差异。
 */
function allocateTips(
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
  const discountCents = Math.max(0, toCents(input.discountDollars));
  const afterDiscountCents = Math.max(0, input.baseCents - discountCents);
  const taxCents = Math.round(afterDiscountCents * toRate(input.taxRatePercent));

  const totalTipCents = input.tipMode === 'total_split'
    ? (input.totalTipDollars !== ''
        ? Math.max(0, toCents(input.totalTipDollars))
        : Math.round((afterDiscountCents * input.tipPercentage) / 100))
    : Object.values(input.customStaffTips).reduce(
        (sum, value) => sum + Math.max(0, toCents(value || '0')),
        0,
      );

  /*
   * 刷卡附加费只按「服务 + 税」计收。
   * 多数州禁止对小费部分加收刷卡手续费 —— 把小费算进基数是实打实的合规风险。
   */
  const cardAccepted = input.paymentMethod === 'card' || input.paymentMethod === 'apple_pay';
  const cardSurchargeCents = input.enableCardSurcharge && cardAccepted
    ? Math.round((afterDiscountCents + taxCents) * toRate(input.cardSurchargePercent))
    : 0;

  const allocated = input.tipMode === 'custom_per_staff'
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

  const totalDueCents = afterDiscountCents + taxCents + cardSurchargeCents;

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
