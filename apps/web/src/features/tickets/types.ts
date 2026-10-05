export interface TicketItem {
  ticketItemId: string;
  name: string;
  totalCents: number;
  durationMin: number;
  startedAt: string | null;
  finishedAt: string | null;
  resourceId?: string | null;
  roomName?: string | null;
  staffName: string;
  membershipId: string;
  /** 组合套餐子项归属（U10）。普通行全部为空。 */
  bundleInstanceId?: string | null;
  bundleComponentId?: string | null;
  bundleUnitIndex?: number | null;
  /** 下单时锁定的单项目录原价（收据展示「原价 / 套餐价」用）。 */
  bundleListPriceCents?: number | null;
}

/** 一张工单上的一份组合套餐实例（U10）。 */
export interface TicketBundle {
  instanceId: string;
  name: string;
  bundlePriceCents: number;
  discountCents: number;
  extraDiscountCents: number;
  unitCount: number;
  /** 已完工的有效子项数。 */
  doneCount: number;
  /** 全部有效子项完工时为真 —— 完成 1/3 不让整单提前完工。 */
  fulfilled: boolean;
  status: 'active' | 'split' | 'cancelled' | string;
}

/** 门店结账时机。与服务端 `location_settings.checkout_timing` 的快照一致。 */
export type CheckoutTiming = 'service_then_tip' | 'upfront_combined' | 'after_service_combined';

export interface TicketSummary {
  ticketId: string;
  appointmentId: string | null;
  status: 'open' | 'in_service' | 'ready_to_pay';
  customerName: string;
  customerId?: string | null;
  subtotalCents: number;
  /**
   * 收款阶段判定所需的三项事实。`GET /v1/desk/tickets` 一直在返回，
   * 此前类型上没有声明，运营看板因此拿不到阶段信息，只能一律按 combined 发起收款。
   */
  checkoutTiming: CheckoutTiming;
  serviceSettledAt: string | null;
  tipSettledAt: string | null;
  /** 全部项目均已完工时为真。由服务端按项目聚合，前端不再自行推断。 */
  serviceCompleted: boolean;
  groupId: string | null;
  groupLabel: string | null;
  businessDate: string;
  daysAgo: number;
  items: TicketItem[];
  /** 这张工单上的组合套餐实例（U10）。无套餐时为空数组。 */
  bundles?: TicketBundle[];
}

export interface TicketsQueryResponse {
  businessDate: string;
  tickets: TicketSummary[];
  staleCount: number;
}

export type VoidReason =
  | 'duplicate_booking'
  | 'walk_out'
  | 'guest_changed_mind'
  | 'input_error'
  | 'paid_externally'
  | 'other';

export interface VoidTicketInput {
  ticketId: string;
  reason: VoidReason;
  /**
   * ⚠️ 字段名必须是 `note`，与 `ticket.void` 的契约一致。
   * 此前这里叫 `notes`，zod 会静默剥掉未声明的键 —— 前台填的作废说明
   * 一路发到服务端就消失了，且没有任何报错。
   */
  note?: string;
}

export interface OrderItemDto {
  itemId: string;
  name: string;
  kind: string;
  quantity: number;
  unitPriceCents: number;
  totalCents: number;
  durationMin?: number;
  staffName: string | null;
  membershipId: string | null;
}

export interface OrderPaymentDto {
  paymentId: string;
  method: string;
  amountCents: number;
  cardLast4: string | null;
  tenderedCents?: number | null;
  changeCents?: number;
}

export interface OrderRowDto {
  membershipCoveredCents?:number;
  packageCoveredCents?:number;
  ticketId: string;
  businessDate: string;
  status: string;
  customerName: string;
  customerPhone: string | null;
  customerId: string | null;
  openedAt: string;
  closedAt: string | null;
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  surchargeCents: number;
  tipCents: number;
  totalCents: number;
  refundCents: number;
  refundTipCents: number;
  refundTaxCents: number;
  refundFeeCents: number;
  items: OrderItemDto[];
  payments: OrderPaymentDto[];
  tipAllocations: Array<{
    staffName: string;
    amountCents: number;
  }>;
}

export interface OrdersQueryResponse {
  total: number;
  rows: OrderRowDto[];
}

export interface OrdersQueryParams {
  status?: string;
  from?: string;
  to?: string;
  staffId?: string;
  paymentMethod?: string;
  minAmount?: number;
  maxAmount?: number;
  q?: string;
  limit?: number;
  offset?: number;
}

export interface RefundTicketInput {
  ticketId: string;
  amountCents: number;
  refundTipCents?: number;
  reason: 'customer_dissatisfied' | 'wrong_charge' | 'duplicate' | 'other';
  method: 'original_payment' | 'cash' | 'store_credit';
  notes?: string;
  reviewHash?: string;
  refundItems?:Array<{ticketItemId:string;amountCents:number}>;
}
export interface TicketRefundPreview {
  reviewHash: string; amountCents: number; tipCents: number; taxCents: number; feeCents: number;
  destinations: Array<{kind:'cash'|'card'|'gift_card'|'store_credit'|'deposit'|'membership'|'package';amountCents:number}>;
  itemGraphAvailable?:boolean;
  items?:Array<{ticketItemId:string;name:string;remainingCents:number}>;
}
