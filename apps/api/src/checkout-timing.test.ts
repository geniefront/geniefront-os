/**
 * Checkout-timing contract assertions.
 *
 * This file deliberately has no database fixture: its job is to pin the
 * migration/schema/handler agreement while the behavioural API suite runs in
 * the database-enabled pipeline.  Do not replace those integration checks with
 * this static contract test.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8');
const ticketHandler = source('./handlers/ticket.ts');
const staffHandler = source('./handlers/staff.ts');
const migration = source('../../../packages/db/sql/0069_checkout_timing.sql');
const ticketSchema = source('../../../packages/db/src/schema/tickets.ts');
const setupCommand = source('../../../packages/contracts/src/commands/setup.ts');
const ticketCommand = source('../../../packages/contracts/src/commands/ticket.ts');

describe('checkout timing contract (database integration deferred)', () => {
  it('C: rejects service_then_tip stage on combined settlement and keeps ticket.close combined', () => {
    expect(ticketHandler).toContain("ticket.checkoutTiming === 'service_then_tip'");
    expect(ticketCommand).toContain("paymentStage: z.literal('combined').default('combined')");
  });

  it('A: permits service before completion, then tip/no-tip close without overwriting service charges', () => {
    expect(ticketHandler).toContain("ticket.checkoutTiming !== 'service_then_tip'");
    expect(ticketHandler).toContain("reason: 'service_stage_not_available'");
    expect(ticketHandler).toContain("reason: 'tip_stage_not_available'");
    expect(ticketHandler).toContain("zero_tip_payment_not_allowed");
    expect(ticketHandler).toContain("case when ${settlementStage} = 'tip' then discount_cents else ${discountCents} end");
    expect(ticketHandler).toContain("case when ${settlementStage} = 'tip' then tax_cents else ${taxCents} end");
    expect(ticketHandler).toContain("case when ${settlementStage} = 'tip' then surcharge_cents else ${surchargeCents} end");
  });

  it('B: settles once before completion and closes on the final finish without another payment', () => {
    expect(ticketHandler).toContain("service_settled_at = case when ${settlementStage} in ('service', 'combined') then now()");
    expect(ticketHandler).toContain("tip_settled_at = case when ${settlementStage} in ('tip', 'combined') then now()");
    expect(staffHandler).toContain("row.checkout_timing_snapshot === 'upfront_combined'");
    expect(staffHandler).toContain("row.service_settled_at !== null && row.tip_settled_at !== null");
  });

  it('locks the ticket before each settlement and rejects a repeated stage independent of idempotency', () => {
    expect(ticketHandler).toContain('from tickets where id = ${ticketId} for update');
    expect(ticketHandler).toContain('ticket.serviceSettledAt || ticket.tipSettledAt');
  });

  it('requires a full prepaid refund and reverses terminal earnings and allocations', () => {
    expect(ticketHandler).toContain('prepaid_ticket_requires_full_refund');
    expect(ticketHandler).toContain('input.refundTipCents !== t.tip_cents - (already?.tip ?? 0)');
    expect(ticketHandler).toContain('update tip_allocations');
    expect(ticketHandler).toContain('update earnings');
  });

  it('keeps settings values, ticket snapshot, migration backfill, and appointment index in agreement', () => {
    expect(setupCommand).toContain("'service_then_tip', 'upfront_combined', 'after_service_combined'");
    expect(ticketHandler).toContain('checkout_timing_snapshot');
    expect(migration).toContain("update payments set stage = 'combined'");
    expect(migration).toContain("status not in ('voided', 'refunded')");
    expect(ticketSchema).toContain("status} not in ('voided', 'refunded')");
  });
});
