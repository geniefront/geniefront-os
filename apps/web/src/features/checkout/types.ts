/**
 * 结账相关类型，与服务端 `GET /v1/desk/tickets` 及 `ticket.*` 命令对应。
 *
 * ⚠️ 金额一律以**分**为单位的整数传递与运算，绝不使用浮点。
 * `Number("1.005") * 100` 得到 100.49999999999999，四舍五入后是 100 而非 101 ——
 * 这类误差只在特定小数上出现，测不出来也查不到，而门店会因为差一分来问。
 */

export interface TicketItem {
  ticketItemId: string;
  name: string;
  totalCents: number;
  durationMin: number;
  staffName: string | null;
  membershipId: string | null;
}

export interface OpenTicket {
  ticketId: string;
  customerName: string;
  status?: 'open' | 'in_service' | 'ready_to_pay' | string;
  subtotalCents: number;
  discountCents?: number;
  taxCents?: number;
  totalCents?: number;
  /** 同行客人合单时非空，结账可整组一起收。 */
  groupId: string | null;
  groupLabel: string | null;
  businessDate: string;
  /** 距今天数。大于 0 表示这是一张跨日未结的单，需要前台留意。 */
  daysAgo: number;
  items: TicketItem[];
}

export interface OpenTicketsView {
  businessDate: string;
  tickets: OpenTicket[];
  checkoutSettings?: {
    salesTaxRatePercent: string;
    taxCalculationMode: 'exclusive' | 'inclusive';
    suggestedTipPercentages: number[];
  };
  staleCount?: number;
}

/** 支付方式。取值与服务端 `paymentMethod` 枚举一致。 */
export const PAYMENT_METHODS = ['cash', 'card', 'gift_card', 'external'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/**
 * 一笔收款。
 *
 * ⚠️ `amountCents` **含小费**，与刷卡机小票上的数字一致 ——
 * 日结时要拿系统数去比对终端 batch total，两边口径必须相同。
 *
 * ⚠️ 现金「不用找了」必须落成 `keepChange: true` 且 `changeCents: 0`，
 * 由服务端转入小费。不记录的话打烊点钞会平白多出这笔钱，
 * 而账面上无法解释，最终变成对前台的怀疑。
 */
export interface PaymentLine {
  method: PaymentMethod;
  /**
   * ⚠️ **含小费**，与刷卡机小票上的数字一致。
   * 服务端校验：`Σ amountCents === 服务金额 − 折扣 + Σ tipCents`，
   * 不相等直接拒绝（PAYMENT_MISMATCH）。
   *
   * 界面不直接采集该值 —— 前台的心智模型是「这笔收了多少服务费、多少小费」，
   * 实收由二者相加得出，避免把口径换算的责任交给操作者。
   */
  amountCents: number;
  tipCents: number;
  /** 客人递过来的现金总额。刷卡不填。 */
  tenderedCents?: number;
  changeCents: number;
  keepChange: boolean;
  /** `method = 'gift_card'` 时必填其一：扫码给 id，客人念号给 code。 */
  giftCardId?: string;
  giftCardCode?: string;
}

export interface CloseAllocation {
  membershipId: string;
  name: string;
  amountCents: number;
  source: 'cash' | 'card';
  explain: string;
}

export interface CloseResult {
  ticketId: string;
  totalCents: number;
  tipCents: number;
  /** 小费分配结果。前台需当场看到每位技师分到多少。 */
  allocations: CloseAllocation[];
}

export interface GiftCardVerifyResult {
  valid: boolean;
  giftCardId: string;
  code: string;
  balanceCents: number;
  recipientName?: string;
  status: string;
}

export interface SendTicketReceiptInput {
  ticketId: string;
  channel: 'sms' | 'email';
  destination?: string;
}

export interface SendTicketReceiptResult {
  ticketId: string;
  channel: 'sms' | 'email';
  destination: string;
  outboxId: string;
}
