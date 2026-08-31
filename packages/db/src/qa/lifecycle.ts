/**
 * Business-lifecycle fixtures.
 *
 * These inserts match the resulting rows of:
 *   appointment.create, queue.join, ticket.open, ticket.close / ticket.pay,
 *   giftcard.issue, dayclose.saveCount
 *
 * They do not invent impossible combinations (closed ticket without
 * payments, gift-card balance without ledger, finalized day-close with
 * invented totals).
 */

import type postgres from 'postgres';
import { atWall, businessDateOf, iso, type QaClock } from './clock';
import { qaGiftCardCode, qaUuid } from './ids';
import type { SeededLocation } from './bootstrap';
import type { ShopCatalog } from './shopData';
import type { QaScenarioId } from './types';

function locClock(clock: QaClock, loc: SeededLocation): QaClock {
  return { ...clock, timezone: loc.timezone, cutoff: loc.cutoff };
}

export async function createAppointment(
  tx: postgres.TransactionSql,
  args: {
    scenario: QaScenarioId;
    loc: SeededLocation;
    catalog: ShopCatalog;
    clock: QaClock;
    key: string;
    customerKey: string;
    staffKey: string;
    serviceKey: string;
    time: string;
    status: 'booked' | 'checked_in' | 'in_service' | 'completed';
    source?: 'desk' | 'web' | 'walkin';
  },
): Promise<{ appointmentId: string; startsAt: Date; durationMin: number; priceCents: number }> {
  const clock = locClock(args.clock, args.loc);
  const date = businessDateOf(clock);
  const meta = args.catalog.serviceMeta[args.serviceKey]!;
  const startsAt = atWall(clock, date, args.time);
  const endsAt = new Date(startsAt.getTime() + meta.durationMin * 60_000);
  const appointmentId = qaUuid(`apt:${args.scenario}:${args.loc.key}:${args.key}`);
  const staff = args.loc.people[args.staffKey]!;
  await tx`insert into appointments (
      id, org_id, location_id, customer_id, business_date, starts_at, ends_at,
      status, source, notes
    ) values (
      ${appointmentId}, ${args.loc.orgId}, ${args.loc.locationId},
      ${args.catalog.customerIds[args.customerKey]!}, ${date},
      ${iso(startsAt)}::timestamptz, ${iso(endsAt)}::timestamptz,
      ${args.status}, ${args.source ?? 'desk'}, ${`qa:${args.scenario}`}
    )`;
  await tx`insert into appointment_items (
      org_id, location_id, appointment_id, service_id, membership_id,
      starts_at, ends_at, price_cents_snapshot, duration_min, status
    ) values (
      ${args.loc.orgId}, ${args.loc.locationId}, ${appointmentId},
      ${args.catalog.serviceIds[args.serviceKey]!}, ${staff.membershipId},
      ${iso(startsAt)}::timestamptz, ${iso(endsAt)}::timestamptz,
      ${meta.priceCents}, ${meta.durationMin}, ${args.status}
    )`;
  return { appointmentId, startsAt, durationMin: meta.durationMin, priceCents: meta.priceCents };
}

export async function openTicket(
  tx: postgres.TransactionSql,
  args: {
    scenario: QaScenarioId;
    loc: SeededLocation;
    catalog: ShopCatalog;
    clock: QaClock;
    key: string;
    customerKey: string;
    staffKey: string;
    serviceKey: string;
    appointmentId: string;
    openedAt: Date;
    status: 'open' | 'closed' | 'in_service';
    closed?: { method: 'cash' | 'card'; tipCents: number };
  },
): Promise<{ ticketId: string; totalCents: number }> {
  const clock = locClock(args.clock, args.loc);
  const date = businessDateOf(clock);
  const meta = args.catalog.serviceMeta[args.serviceKey]!;
  const tip = args.closed?.tipCents ?? 0;
  const total = meta.priceCents + tip;
  const ticketId = qaUuid(`tkt:${args.scenario}:${args.loc.key}:${args.key}`);
  const opener = args.loc.people['front_desk']?.membershipId
    ?? args.loc.people['owner']!.membershipId;
  const staff = args.loc.people[args.staffKey]!;

  await tx`insert into tickets (
      id, org_id, location_id, customer_id, appointment_id, business_date, status,
      opened_at, closed_at, opened_by, closed_by,
      subtotal_cents, discount_cents, tax_cents, tip_cents, total_cents
    ) values (
      ${ticketId}, ${args.loc.orgId}, ${args.loc.locationId},
      ${args.catalog.customerIds[args.customerKey]!}, ${args.appointmentId}, ${date},
      ${args.status},
      ${iso(args.openedAt)}::timestamptz,
      ${args.status === 'closed' ? iso(new Date(args.openedAt.getTime() + meta.durationMin * 60_000)) : null}::timestamptz,
      ${opener}, ${args.status === 'closed' ? opener : null},
      ${meta.priceCents}, 0, 0, ${tip}, ${total}
    )`;

  const itemId = qaUuid(`ti:${args.scenario}:${args.loc.key}:${args.key}`);
  const startedAt = args.status === 'in_service' ? iso(args.openedAt) : null;
  await tx`insert into ticket_items (
      id, org_id, location_id, ticket_id, service_id, kind, name_snapshot,
      unit_price_cents, total_cents, duration_min, started_at
    ) values (
      ${itemId}, ${args.loc.orgId}, ${args.loc.locationId}, ${ticketId},
      ${args.catalog.serviceIds[args.serviceKey]!}, 'service', ${meta.name},
      ${meta.priceCents}, ${meta.priceCents}, ${meta.durationMin},
      ${startedAt}::timestamptz
    )`;
  await tx`insert into ticket_item_staff (org_id, ticket_item_id, membership_id, role, minutes)
    values (${args.loc.orgId}, ${itemId}, ${staff.membershipId}, 'primary', ${meta.durationMin})`;

  if (args.closed) {
    await tx`insert into payments (
        org_id, location_id, ticket_id, method, amount_cents, tip_cents, change_cents, taken_by, stage
      ) values (
        ${args.loc.orgId}, ${args.loc.locationId}, ${ticketId}, ${args.closed.method},
        ${total}, ${tip}, 0, ${opener}, 'combined'
      )`;
    if (tip > 0) {
      await tx`insert into tip_allocations (
          org_id, location_id, ticket_id, membership_id, amount_cents, basis, source, policy_version
        ) values (
          ${args.loc.orgId}, ${args.loc.locationId}, ${ticketId}, ${staff.membershipId},
          ${tip}, '{"method":"direct"}'::jsonb, ${args.closed.method}, 1
        )`;
    }
    await tx`insert into earnings (
        org_id, location_id, membership_id, ticket_id, business_date, kind, amount_cents, base_cents
      ) values (
        ${args.loc.orgId}, ${args.loc.locationId}, ${staff.membershipId}, ${ticketId}, ${date},
        'commission', ${Math.round(meta.priceCents * 0.45)}, ${meta.priceCents}
      )`;
  }

  return { ticketId, totalCents: total };
}

export async function joinQueue(
  tx: postgres.TransactionSql,
  args: {
    scenario: QaScenarioId;
    loc: SeededLocation;
    catalog: ShopCatalog;
    clock: QaClock;
    key: string;
    customerKey: string;
    ticketNumber: number;
    status: 'waiting' | 'called';
    appointmentId: string;
  },
): Promise<void> {
  const clock = locClock(args.clock, args.loc);
  const date = businessDateOf(clock);
  const id = qaUuid(`q:${args.scenario}:${args.loc.key}:${args.key}`);
  await tx`insert into walkin_queue (
      id, org_id, location_id, customer_id, business_date, ticket_number,
      status, source, quoted_wait_min, joined_at, appointment_id
    ) values (
      ${id}, ${args.loc.orgId}, ${args.loc.locationId},
      ${args.catalog.customerIds[args.customerKey]!}, ${date}, ${args.ticketNumber},
      ${args.status}, 'kiosk', ${args.status === 'waiting' ? 12 : 0},
      now() - (${args.status === 'waiting' ? 10 : 3} * interval '1 minute'),
      ${args.appointmentId}
    )`;
}

export async function issueGiftCard(
  tx: postgres.TransactionSql,
  args: {
    scenario: QaScenarioId;
    loc: SeededLocation;
    catalog: ShopCatalog;
    key: string;
    customerKey: string;
    faceValueCents: number;
    salePriceCents: number;
  },
): Promise<string> {
  const cardId = qaUuid(`gc:${args.scenario}:${args.loc.key}:${args.key}`);
  const code = qaGiftCardCode(`${args.scenario}:${args.loc.key}:${args.key}`);
  const issuer = args.loc.people['front_desk']?.membershipId
    ?? args.loc.people['owner']!.membershipId;
  const holder = args.catalog.customerIds[args.customerKey]!;

  await tx`insert into gift_cards (
      id, org_id, location_id, code, face_value_cents, sale_price_cents,
      balance_cents, scope, status, source, holder_customer_id, purchaser_customer_id,
      issued_by
    ) values (
      ${cardId}, ${args.loc.orgId}, ${args.loc.locationId}, ${code},
      ${args.faceValueCents}, ${args.salePriceCents}, 0, 'location', 'active',
      'front_desk', ${holder}, ${holder}, ${issuer}
    )`;
  await tx`insert into customer_credit_ledger (
      org_id, location_id, kind, subject_id, customer_id, entry,
      amount_cents, balance_after_cents, actor_membership_id, meta
    ) values (
      ${args.loc.orgId}, ${args.loc.locationId}, 'gift_card', ${cardId}, ${holder},
      'issue', ${args.faceValueCents}, ${args.faceValueCents}, ${issuer},
      ${tx.json({ salePriceCents: args.salePriceCents, source: 'front_desk' })}
    )`;
  await tx`update gift_cards set balance_cents = ${args.faceValueCents} where id = ${cardId}`;
  return cardId;
}

export async function prepareDayCloseCount(
  tx: postgres.TransactionSql,
  args: {
    loc: SeededLocation;
    clock: QaClock;
    countedCashCents: number;
    cardTerminalCents: number;
  },
): Promise<void> {
  const clock = locClock(args.clock, args.loc);
  const date = businessDateOf(clock);
  const closer = args.loc.people['owner']!.membershipId;
  await tx`insert into day_closes (
      org_id, location_id, business_date, status,
      opening_float_cents, closing_float_cents,
      counted_cash_cents, card_terminal_cents, cash_variance_cents, card_variance_cents,
      counted_by, counted_at
    ) values (
      ${args.loc.orgId}, ${args.loc.locationId}, ${date}, 'counted',
      0, 0,
      ${args.countedCashCents}, ${args.cardTerminalCents}, 0, 0,
      ${closer}, now()
    )`;
}
