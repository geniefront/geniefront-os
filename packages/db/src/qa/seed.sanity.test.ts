process.env['GF_QA_ALLOW_RESET'] = '1';
process.env['SEED_SKIP_AUTH'] = '1';
process.env['QA_NOW'] = '2026-08-30T16:00:00.000Z';
process.env['NODE_ENV'] = 'test';

import { afterAll, describe, expect, it } from 'vitest';
import { includedFor } from '@gf/payroll';
import { adminSql } from '../admin';
import { qaEmail, qaUuid } from './ids';
import { runQaSeed, runQaSeedTwice } from './runner';
import { logicalSnapshot } from './snapshot';
import type { QaScenarioId } from './types';

afterAll(async () => {
  await adminSql.end({ timeout: 5 });
});

async function billing(locationId: string) {
  const [row] = await adminSql<{
    plan: string; subscription_status: string; trial_ends_at: Date | string | null;
    included_credits_used: number; included_minutes_used: number;
  }[]>`
    select plan, subscription_status, trial_ends_at,
           included_credits_used, included_minutes_used
    from billing_accounts where location_id = ${locationId}`;
  return row!;
}

describe('Seed V2 sanity', () => {
  it('reset+seed twice is logically identical for essential_trial', async () => {
    const { first, second } = await runQaSeedTwice('essential_trial');
    expect(logicalSnapshot(second)).toEqual(logicalSnapshot(first));
    expect(first.orgCount).toBe(1);
    expect(first.locationCount).toBe(1);
    expect(first.plan).toBe('essential');
    expect(first.subscriptionStatus).toBe('trialing');
    expect(first.trialEndsInFuture).toBe(true);
    expect(first.loginEmails).toContain(qaEmail('essential_trial'));
  });

  it('essential_trial uses trial quota, not full Essential included quota', async () => {
    await runQaSeed('essential_trial');
    const loc = qaUuid('loc:essential_trial:main');
    const row = await billing(loc);
    expect(row.plan).toBe('essential');
    expect(row.subscription_status).toBe('trialing');
    expect(new Date(row.trial_ends_at!).getTime()).toBeGreaterThan(Date.parse('2026-08-30T16:00:00.000Z'));
    expect(includedFor(row.plan, 'credit', true)).toBe(150);
    expect(includedFor(row.plan, 'voice_minute', true)).toBe(20);
    expect(includedFor(row.plan, 'credit', false)).toBe(500);
    expect(row.included_credits_used).toBe(0);
    expect(row.included_minutes_used).toBe(0);
  });

  it('growth_active is growth/active with Growth quota', async () => {
    const { snapshot } = await runQaSeed('growth_active');
    expect(snapshot.plan).toBe('growth');
    expect(snapshot.subscriptionStatus).toBe('active');
    expect(snapshot.trialEndsInFuture).not.toBe(true);
    const loc = qaUuid('loc:growth_active:main');
    const row = await billing(loc);
    expect(includedFor(row.plan, 'credit', false)).toBe(1200);
    expect(includedFor(row.plan, 'voice_minute', false)).toBe(500);
  });

  it('past_due freezes at the billing row, not a frontend flag', async () => {
    const { snapshot } = await runQaSeed('past_due');
    expect(snapshot.subscriptionStatus).toBe('past_due');
    expect(snapshot.plan).toBe('growth');
  });

  it('multi_location_owner has distinct tenant data on both shops', async () => {
    const { first, second } = await runQaSeedTwice('multi_location_owner');
    expect(logicalSnapshot(second)).toEqual(logicalSnapshot(first));
    expect(first.locationCount).toBe(2);
    expect(first.membershipCount).toBeGreaterThanOrEqual(4);

    const east = await adminSql<{ n: string }[]>`
      select display_name as n from customers
      where primary_location_id = ${qaUuid('loc:multi_location_owner:east')}
      order by display_name`;
    const west = await adminSql<{ n: string }[]>`
      select display_name as n from customers
      where primary_location_id = ${qaUuid('loc:multi_location_owner:west')}
      order by display_name`;
    expect(east.map((r) => r.n)).toEqual(['Emily Stone', 'Lisa Park']);
    expect(west.map((r) => r.n)).toEqual(['David Chen', 'Ming Wang']);
    expect(east.map((r) => r.n).some((n) => west.map((w) => w.n).includes(n))).toBe(false);
  });

  it('tech_only login membership is tech, not owner/front_desk', async () => {
    await runQaSeed('tech_only');
    const roles = await adminSql<{ key: string }[]>`
      select r.key from memberships m
      join users u on u.id = m.user_id
      join membership_roles mr on mr.membership_id = m.id
      join roles r on r.id = mr.role_id
      where lower(u.email) = ${qaEmail('tech_only')}`;
    expect(roles.map((r) => r.key)).toEqual(['tech']);
    expect(roles.map((r) => r.key)).not.toContain('owner');
    expect(roles.map((r) => r.key)).not.toContain('front_desk');
  });

  it('platform_operator is an active platform_operators row, not an owner role', async () => {
    await runQaSeed('platform_operator');
    const [row] = await adminSql<{ role: string; status: string; memberships: number }[]>`
      select po.role, po.status,
             (select count(*)::int from memberships m where m.user_id = po.user_id) as memberships
      from platform_operators po
      join users u on u.id = po.user_id
      where lower(u.email) = ${qaEmail('platform_operator')}`;
    expect(row).toMatchObject({ role: 'super_admin', status: 'active', memberships: 0 });
  });

  it('revoked_platform_operator is revoked with a relative revoked_at', async () => {
    await runQaSeed('revoked_platform_operator');
    const [row] = await adminSql<{ status: string; revoked_at: Date | string | null }[]>`
      select po.status, po.revoked_at
      from platform_operators po
      join users u on u.id = po.user_id
      where lower(u.email) = ${qaEmail('revoked_platform_operator')}`;
    expect(row?.status).toBe('revoked');
    expect(row?.revoked_at).not.toBeNull();
    expect(new Date(row!.revoked_at!).getTime()).toBeLessThan(Date.parse('2026-08-30T16:00:00.000Z'));
  });

  it('ten_dlc_pending is internal review, not carrier/TCR submitted', async () => {
    const { snapshot } = await runQaSeed('ten_dlc_pending');
    expect(snapshot.tenDlcStatus).toBe('pending_review');
    const [row] = await adminSql<{ notes: string | null }[]>`
      select notes from location_10dlc_registrations
      where location_id = ${qaUuid('loc:ten_dlc_pending:main')}`;
    expect(row?.notes ?? '').toMatch(/Internal GenieFront review/i);
    expect(row?.notes ?? '').toMatch(/Not filed with TCR or a carrier/i);
    expect(row?.notes ?? '').not.toMatch(/carrier submitted|starts the carrier review|filed with the US TCR/i);
  });

  it('growth_active projects a Stripe-equivalent default payment method', async () => {
    await runQaSeed('growth_active');
    const [row] = await adminSql<{
      default_payment_method_id: string | null; payment_method_label: string | null;
    }[]>`
      select default_payment_method_id, payment_method_label
      from billing_accounts where location_id = ${qaUuid('loc:growth_active:main')}`;
    expect(row?.default_payment_method_id).toMatch(/^pm_qa_/);
    expect(row?.payment_method_label).toBe('Visa ···· 4242');
  });

  it('busy_shop in-service visits have a started unfinished ticket item', async () => {
    await runQaSeed('busy_shop');
    const loc = qaUuid('loc:busy_shop:main');
    const visits = await adminSql<{
      appointment_status: string; ticket_status: string;
      started_at: Date | string | null; finished_at: Date | string | null;
    }[]>`
      select a.status as appointment_status, t.status as ticket_status,
             ti.started_at, ti.finished_at
      from appointments a
      join tickets t on t.appointment_id = a.id
      join ticket_items ti on ti.ticket_id = t.id
      where a.location_id = ${loc} and a.status = 'in_service'`;
    expect(visits.length).toBeGreaterThan(0);
    for (const visit of visits) {
      expect(visit.ticket_status).toBe('in_service');
      expect(visit.started_at).not.toBeNull();
      expect(visit.finished_at).toBeNull();
    }
  });

  it('gift_card_shop ledger sum equals card balances', async () => {
    const { snapshot } = await runQaSeed('gift_card_shop');
    expect(snapshot.giftCardCount).toBe(1);
    expect(snapshot.giftCardLedgerSum).toBe(10000);
    const [card] = await adminSql<{ balance_cents: number }[]>`
      select balance_cents from gift_cards
      where location_id = ${qaUuid('loc:gift_card_shop:main')}`;
    expect(card?.balance_cents).toBe(snapshot.giftCardLedgerSum);
  });

  it('day_close_ready is counted, not already closed, with matching card total', async () => {
    await runQaSeed('day_close_ready');
    const [day] = await adminSql<{ status: string; counted: number | null; card: number | null }[]>`
      select status, counted_cash_cents as counted, card_terminal_cents as card
      from day_closes where location_id = ${qaUuid('loc:day_close_ready:main')}`;
    expect(day?.status).toBe('counted');
    expect(day?.counted).toBe(0);
    const [pay] = await adminSql<{ n: number }[]>`
      select coalesce(sum(amount_cents), 0)::int as n from payments
      where location_id = ${qaUuid('loc:day_close_ready:main')}`;
    expect(day?.card).toBe(pay?.n);
    const [open] = await adminSql<{ n: number }[]>`
      select count(*)::int as n from tickets
      where location_id = ${qaUuid('loc:day_close_ready:main')}
        and status in ('open', 'in_service', 'ready_to_pay')`;
    expect(open?.n).toBe(0);
  });

  it.each([
    'fresh_owner',
    'setup_incomplete',
    'growth_setup',
    'empty_shop',
    'busy_shop',
    'storefront_pending',
    'support_request_open',
    'owner',
    'manager_or_front_desk',
  ] as QaScenarioId[])('seeds %s without duplicate rows on second reset', async (scenario) => {
    const { first, second } = await runQaSeedTwice(scenario);
    expect(logicalSnapshot(second)).toEqual(logicalSnapshot(first));
  });
});
