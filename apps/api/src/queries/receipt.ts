import type postgres from 'postgres';
import { AppError, ERROR_CODES, pickText, type CommandContext } from '@gf/contracts';
import { loadOrders } from './orders';

export async function loadReceipt(tx: postgres.TransactionSql, ctx: CommandContext, ticketId: string) {
  // Both the exact order lookup and store metadata remain tenant scoped.
  const result = await loadOrders(tx, { ...ctx, locale: 'en' }, { ticketId, limit: 1 });
  const order = result.rows[0];
  if (!order) throw new AppError(ERROR_CODES.NOT_FOUND);
  const [store] = await tx<{
    address: Record<string, string> | null;
    name: unknown; timezone: string; phone: string | null;
    address_street: string | null; address_city: string | null;
    address_state: string | null; address_zip: string | null;
    receipt_footer_message: string | null;
  }[]>`
    select l.name, l.timezone, l.phone, l.address, l.address_street, l.address_city,
           l.address_state, l.address_zip, s.receipt_footer_message
    from locations l left join location_checkout_settings s on s.location_id = l.id
    where l.id = ${ctx.locationId}`;
  if (!store) throw new AppError(ERROR_CODES.NOT_FOUND);
  const [credit] = await tx<{ cents: number }[]>`
    select coalesce(sum((meta->>'coveredCents')::int), 0)::int as cents
    from customer_credit_ledger
    where location_id = ${ctx.locationId} and ticket_id = ${ticketId}
      and kind = 'package' and entry = 'redeem'`;
  const address = store.address ?? {};
  const [membershipCredit]=await tx<{cents:number}[]>`select coalesce(sum(covered_cents),0)::int as cents from customer_membership_ledger where ticket_id=${ticketId} and entry='redeem'`;
  const [membershipReturn]=await tx<{cents:number}[]>`select coalesce(sum(membership_cents),0)::int as cents from ticket_refunds where ticket_id=${ticketId}`;
  return {
    order,
    packageCreditCents: credit?.cents ?? 0,
    membershipCreditCents:membershipCredit?.cents??0,
    membershipReturnedCents:membershipReturn?.cents??0,
    store: {
      name: pickText(store.name, 'en'), timezone: store.timezone, phone: store.phone,
      address: [store.address_street || address.line1 || address.street || address.address, [store.address_city || address.city, store.address_state || address.state, store.address_zip || address.zip || address.postalCode].filter(Boolean).join(' ')].filter(Boolean),
      footer: store.receipt_footer_message ?? 'Thank you for your visit!',
    },
  };
}
