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

  /*
   * ⚠️ `/v1/desk/tickets` 是 `join ticket_item_staff` —— 一个项目派了几位技师
   * 就返回几行，**每一行都带着这个项目的完整金额**。直接遍历原始行会把双人
   * 项目的 $100 记成 A 一百、B 一百，营收基数变成 $200；比例分账的权重正是
   * 按这个基数算的，于是双人项目与单人项目混在同一张单里时，分出来的小费
   * 与实际执行不符，弹窗上给前台看的每人营收也是错的。
   *
   * 因此这里按 ticketItemId 把金额在协作的技师之间均摊：一条项目的金额之和
   * 恒等于它本身，而双技师各拿一半正是提成的实际口径。
   */
  const ticketItems = source.rawTicket?.items ?? [];
  if (ticketItems.length > 0) {
    const staffCountByItem = new Map<string, number>();
    for (const ticketItem of ticketItems) {
      staffCountByItem.set(ticketItem.ticketItemId, (staffCountByItem.get(ticketItem.ticketItemId) ?? 0) + 1);
    }
    const assignedSoFar = new Map<string, number>();
    ticketItems.forEach((ticketItem) => {
      const shares = staffCountByItem.get(ticketItem.ticketItemId) ?? 1;
      const index = assignedSoFar.get(ticketItem.ticketItemId) ?? 0;
      assignedSoFar.set(ticketItem.ticketItemId, index + 1);
      // 尾差补给最后一位，保证各行之和等于该项目的金额，不产生对不上的一分钱。
      const share = index === shares - 1
        ? ticketItem.totalCents - Math.floor(ticketItem.totalCents / shares) * (shares - 1)
        : Math.floor(ticketItem.totalCents / shares);
      push(
        ticketItem.membershipId || UNRESOLVED_STAFF_KEY,
        ticketItem.staffName || fallbackStaffName,
        ticketItem.name,
        share,
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
  const stage = input.paymentStage ?? 'combined';
  /*
   * 小费阶段的服务款已经收过，本次不再重复收取，因此服务基数、折扣、税与
   * 刷卡手续费一律归零 —— 这些字段在界面上也是锁死的，两边必须一致。
   */
  const isTipOnly = stage === 'tip';
  const discountCents = isTipOnly ? 0 : Math.max(0, toCents(input.discountDollars));
  const afterDiscountCents = isTipOnly ? 0 : Math.max(0, input.baseCents - discountCents);
  const taxCents = isTipOnly ? 0 : Math.round(afterDiscountCents * toRate(input.taxRatePercent));

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
    ? Math.round((afterDiscountCents + taxCents) * toRate(input.cardSurchargePercent))
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
