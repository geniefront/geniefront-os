/**
 * 订单记录工作台：全量历史订单多维筛选与分页（Tickets.tsx / Orders）
 */

import type postgres from 'postgres';
import { type CommandContext, asInt } from '@gf/contracts';

export interface OrderItemDto {
  itemId: string;
  name: string;
  kind: string;
  quantity: number;
  unitPriceCents: number;
  totalCents: number;
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
  items: OrderItemDto[];
  payments: OrderPaymentDto[];
  tipAllocations: Array<{
    staffName: string;
    amountCents: number;
  }>;
}

export interface LoadOrdersParams {
  status?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  staffId?: string | undefined;
  paymentMethod?: string | undefined;
  minAmount?: number | undefined;
  maxAmount?: number | undefined;
  q?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export async function loadOrders(
  tx: postgres.TransactionSql,
  ctx: CommandContext,
  params: LoadOrdersParams = {},
): Promise<{ total: number; rows: OrderRowDto[] }> {
  const limit = Math.min(100, Math.max(1, params.limit ?? 50));
  const offset = Math.max(0, params.offset ?? 0);
  const status = params.status && params.status !== 'all' ? params.status : null;
  const from = params.from ?? null;
  const to = params.to ?? null;
  const staffId = params.staffId ?? null;
  const paymentMethod = params.paymentMethod ?? null;
  const minAmount = params.minAmount ?? null;
  const maxAmount = params.maxAmount ?? null;
  const q = params.q ? `%${params.q.trim().toLowerCase()}%` : null;

  // 1. 获取符合条件的主 ticket id 列表
  const tickets = await tx<{
    id: string; business_date: string; status: string;
    customer_id: string | null; customer_name: string | null; phone: string | null;
    walk_in_name: string | null; opened_at: Date | string; closed_at: Date | string | null;
    subtotal_cents: number; discount_cents: number; tax_cents: number;
    surcharge_cents: number; tip_cents: number; total_cents: number;
    refund_cents: number;
  }[]>`
    select distinct t.id, t.business_date::text as business_date, t.status,
           t.customer_id, c.display_name as customer_name, c.phone_e164 as phone,
           t.walk_in_name, t.opened_at, t.closed_at,
           t.subtotal_cents, t.discount_cents, t.tax_cents,
           t.surcharge_cents, t.tip_cents, t.total_cents,
           t.refund_cents
    from tickets t
    left join customers c on c.id = t.customer_id
    left join ticket_items ti on ti.ticket_id = t.id
    left join ticket_item_staff tis on tis.ticket_item_id = ti.id
    left join payments p on p.ticket_id = t.id
    where t.location_id = ${ctx.locationId}
      and (${status}::text is null or (
        case
          when ${status} = 'completed' or ${status} = 'closed' then t.status = 'closed'
          when ${status} = 'refunded' then (t.status = 'refunded' or t.refund_cents > 0)
          else t.status = ${status}
        end
      ))
      and (${from}::date is null or t.business_date >= ${from}::date)
      and (${to}::date is null or t.business_date <= ${to}::date)
      and (${staffId}::uuid is null or tis.membership_id = ${staffId}::uuid)
      and (${paymentMethod}::text is null or p.method = ${paymentMethod}::text)
      and (${minAmount}::int is null or t.total_cents >= ${minAmount}::int)
      and (${maxAmount}::int is null or t.total_cents <= ${maxAmount}::int)
      and (${q}::text is null or (
        lower(coalesce(c.display_name, t.walk_in_name, '')) like ${q}
        or coalesce(c.phone_e164, '') like ${q}
        or t.id::text like ${q}
      ))
    order by t.opened_at desc
    limit ${limit} offset ${offset}`;

  if (tickets.length === 0) {
    return { total: 0, rows: [] };
  }

  // 2. 统计总数
  const [totalRow] = await tx<{ count: string }[]>`
    select count(distinct t.id)::text as count
    from tickets t
    left join customers c on c.id = t.customer_id
    left join ticket_items ti on ti.ticket_id = t.id
    left join ticket_item_staff tis on tis.ticket_item_id = ti.id
    left join payments p on p.ticket_id = t.id
    where t.location_id = ${ctx.locationId}
      and (${status}::text is null or (
        case
          when ${status} = 'completed' or ${status} = 'closed' then t.status = 'closed'
          when ${status} = 'refunded' then (t.status = 'refunded' or t.refund_cents > 0)
          else t.status = ${status}
        end
      ))
      and (${from}::date is null or t.business_date >= ${from}::date)
      and (${to}::date is null or t.business_date <= ${to}::date)
      and (${staffId}::uuid is null or tis.membership_id = ${staffId}::uuid)
      and (${paymentMethod}::text is null or p.method = ${paymentMethod}::text)
      and (${minAmount}::int is null or t.total_cents >= ${minAmount}::int)
      and (${maxAmount}::int is null or t.total_cents <= ${maxAmount}::int)
      and (${q}::text is null or (
        lower(coalesce(c.display_name, t.walk_in_name, '')) like ${q}
        or coalesce(c.phone_e164, '') like ${q}
        or t.id::text like ${q}
      ))`;

  const ticketIds = tickets.map((t) => t.id);

  // 3. 批量查询 items, payments, tip_allocations
  const items = await tx<{
    ticket_id: string; id: string; name_snapshot: string; kind: string;
    qty: number; unit_price_cents: number; total_cents: number;
    staff_name: string | null; membership_id: string | null;
  }[]>`
    select ti.ticket_id, ti.id, ti.name_snapshot, ti.kind,
           ti.qty, ti.unit_price_cents, ti.total_cents,
           sp.display_name as staff_name, tis.membership_id
    from ticket_items ti
    left join ticket_item_staff tis on tis.ticket_item_id = ti.id
    left join staff_profiles sp on sp.membership_id = tis.membership_id
    where ti.ticket_id in ${tx(ticketIds)}
    order by ti.seq`;

  const payments = await tx<{
    ticket_id: string; id: string; method: string; amount_cents: number;
  }[]>`
    select ticket_id, id, method, amount_cents
    from payments
    where ticket_id in ${tx(ticketIds)}`;

  const tips = await tx<{
    ticket_id: string; amount_cents: number; display_name: string | null;
  }[]>`
    select ta.ticket_id, ta.amount_cents, sp.display_name
    from tip_allocations ta
    left join staff_profiles sp on sp.membership_id = ta.membership_id
    where ta.ticket_id in ${tx(ticketIds)}`;

  const itemsMap = new Map<string, OrderItemDto[]>();
  for (const i of items) {
    const list = itemsMap.get(i.ticket_id) ?? [];
    list.push({
      itemId: i.id,
      name: i.name_snapshot,
      kind: i.kind,
      quantity: i.qty,
      unitPriceCents: i.unit_price_cents,
      totalCents: i.total_cents,
      staffName: i.staff_name,
      membershipId: i.membership_id,
    });
    itemsMap.set(i.ticket_id, list);
  }

  const paymentsMap = new Map<string, OrderPaymentDto[]>();
  for (const p of payments) {
    const list = paymentsMap.get(p.ticket_id) ?? [];
    list.push({
      paymentId: p.id,
      method: p.method,
      amountCents: p.amount_cents,
      cardLast4: null,
    });
    paymentsMap.set(p.ticket_id, list);
  }

  const tipsMap = new Map<string, Array<{ staffName: string; amountCents: number }>>();
  for (const t of tips) {
    const list = tipsMap.get(t.ticket_id) ?? [];
    list.push({
      staffName: t.display_name ?? '技师',
      amountCents: t.amount_cents,
    });
    tipsMap.set(t.ticket_id, list);
  }

  const rows: OrderRowDto[] = tickets.map((t) => ({
    ticketId: t.id,
    businessDate: t.business_date,
    status: t.status,
    customerName: t.customer_name ?? t.walk_in_name ?? '散客',
    customerPhone: t.phone,
    customerId: t.customer_id,
    openedAt: new Date(t.opened_at).toISOString(),
    closedAt: t.closed_at ? new Date(t.closed_at).toISOString() : null,
    subtotalCents: t.subtotal_cents,
    discountCents: t.discount_cents,
    taxCents: t.tax_cents,
    surchargeCents: t.surcharge_cents,
    tipCents: t.tip_cents,
    totalCents: t.total_cents,
    refundCents: t.refund_cents,
    items: itemsMap.get(t.id) ?? [],
    payments: paymentsMap.get(t.id) ?? [],
    tipAllocations: tipsMap.get(t.id) ?? [],
  }));

  return {
    total: asInt(totalRow?.count, rows.length),
    rows,
  };
}
