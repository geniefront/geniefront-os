import type postgres from 'postgres';
import { QA_SEED_MARKER, type QaScenarioId, type QaSnapshot } from './types';

export async function snapshotQa(
  tx: postgres.TransactionSql,
  scenario: QaScenarioId,
): Promise<QaSnapshot> {
  const [row] = await tx<{
    org_count: number; location_count: number; membership_count: number;
    customer_count: number; service_count: number; appointment_count: number;
    ticket_count: number; payment_count: number; gift_card_count: number;
    gift_ledger: number; queue_count: number; day_close_count: number;
    ten_dlc: string | null; storefront: string | null;
    plan: string | null; subscription_status: string | null;
    trial_future: boolean | null; location_status: string | null;
  }[]>`
    with qa_loc as (
      select id, org_id, status from locations where settings->>'qa_scenario' = ${scenario}
        and settings->>'qa_seed' = ${QA_SEED_MARKER}
    )
    select
      (select count(distinct org_id)::int from qa_loc) as org_count,
      (select count(*)::int from qa_loc) as location_count,
      (select count(*)::int from memberships m join qa_loc l on l.id = m.location_id) as membership_count,
      (select count(*)::int from customers c join qa_loc l on l.org_id = c.org_id) as customer_count,
      (select count(*)::int from services s join qa_loc l on l.id = s.location_id) as service_count,
      (select count(*)::int from appointments a join qa_loc l on l.id = a.location_id) as appointment_count,
      (select count(*)::int from tickets t join qa_loc l on l.id = t.location_id) as ticket_count,
      (select count(*)::int from payments p join qa_loc l on l.id = p.location_id) as payment_count,
      (select count(*)::int from gift_cards g join qa_loc l on l.id = g.location_id) as gift_card_count,
      (select coalesce(sum(amount_cents), 0)::int from customer_credit_ledger cl
         join qa_loc l on l.id = cl.location_id where cl.kind = 'gift_card') as gift_ledger,
      (select count(*)::int from walkin_queue q join qa_loc l on l.id = q.location_id) as queue_count,
      (select count(*)::int from day_closes d join qa_loc l on l.id = d.location_id) as day_close_count,
      (select r.status from location_10dlc_registrations r
         join qa_loc l on l.id = r.location_id limit 1) as ten_dlc,
      (select b.status from storefront_briefs b
         join qa_loc l on l.id = b.location_id limit 1) as storefront,
      (select ba.plan from billing_accounts ba
         join qa_loc l on l.id = ba.location_id order by ba.created_at limit 1) as plan,
      (select ba.subscription_status from billing_accounts ba
         join qa_loc l on l.id = ba.location_id order by ba.created_at limit 1) as subscription_status,
      (select case when ba.trial_ends_at is null then null
                   else ba.trial_ends_at > now() end
         from billing_accounts ba join qa_loc l on l.id = ba.location_id
         order by ba.created_at limit 1) as trial_future,
      (select status from qa_loc order by id limit 1) as location_status`;

  const support = await tx<{ status: string }[]>`
    select sr.status from support_requests sr
    join locations l on l.id = sr.location_id
    where l.settings->>'qa_scenario' = ${scenario}
    order by sr.status`;

  const emails = await tx<{ email: string }[]>`
    select distinct lower(u.email) as email
    from users u
    where lower(u.email) like ${`qa-${scenario}%@maildrop.cc`}
    order by 1`;

  const roles = await tx<{ key: string }[]>`
    select distinct r.key
    from roles r
    join locations l on l.id = r.location_id
    join membership_roles mr on mr.role_id = r.id
    where l.settings->>'qa_scenario' = ${scenario}
    order by r.key`;

  const r = row!;
  return {
    scenario,
    orgCount: r.org_count,
    locationCount: r.location_count,
    membershipCount: r.membership_count,
    customerCount: r.customer_count,
    serviceCount: r.service_count,
    appointmentCount: r.appointment_count,
    ticketCount: r.ticket_count,
    paymentCount: r.payment_count,
    giftCardCount: r.gift_card_count,
    giftCardLedgerSum: r.gift_ledger,
    queueCount: r.queue_count,
    dayCloseCount: r.day_close_count,
    tenDlcStatus: r.ten_dlc,
    storefrontStatus: r.storefront,
    supportStatuses: support.map((s) => s.status),
    plan: r.plan,
    subscriptionStatus: r.subscription_status,
    trialEndsInFuture: r.trial_future,
    locationStatus: r.location_status,
    loginEmails: emails.map((e) => e.email),
    roleKeys: roles.map((x) => x.key),
  };
}

export function logicalSnapshot(s: QaSnapshot): Record<string, unknown> {
  const { ...rest } = s;
  return rest;
}
