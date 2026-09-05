export interface TicketItem {
  ticketItemId: string;
  name: string;
  totalCents: number;
  durationMin: number;
  startedAt: string | null;
  finishedAt: string | null;
  staffName: string;
  membershipId: string;
}

export interface TicketSummary {
  ticketId: string;
  appointmentId: string | null;
  status: 'open' | 'in_service' | 'ready_to_pay';
  customerName: string;
  subtotalCents: number;
  groupId: string | null;
  groupLabel: string | null;
  businessDate: string;
  daysAgo: number;
  items: TicketItem[];
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
  notes?: string;
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
}

export interface OrderRowDto {
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
}
