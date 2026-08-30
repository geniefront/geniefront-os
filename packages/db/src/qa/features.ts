import type postgres from 'postgres';
import { qaUuid } from './ids';
import type { SeededLocation, SeededTenant } from './bootstrap';
import { insertLocalAuthIdentity, upsertQaAuthUser } from './auth';
import { iso, type QaClock } from './clock';
import type { QaScenarioId } from './types';

export async function apply10DlcPending(
  tx: postgres.TransactionSql,
  loc: SeededLocation,
): Promise<void> {
  const owner = loc.people['owner'] ?? Object.values(loc.people)[0]!;
  await tx`insert into location_10dlc_registrations (
      location_id, status, legal_business_name, ein, business_structure,
      registered_address, rep_name, rep_title, rep_email, rep_phone,
      opt_in_method, sample_message_1, sample_messages,
      submitted_at, submitted_by_membership_id, notes, updated_at
    ) values (
      ${loc.locationId}, 'pending_review', ${`${loc.key} LLC`}, '12-3456789', 'llc',
      '100 QA Street, New York, NY 10001', ${owner.email}, 'Owner', ${owner.email},
      '+12125550100', 'verbal_and_web_form',
      'Your appointment at our shop is confirmed.',
      array['Your appointment at our shop is confirmed.']::text[],
      now(), ${owner.membershipId},
      'Internal GenieFront review. Not filed with TCR or a carrier.',
      now()
    )`;
}

export async function submitStorefrontBrief(
  tx: postgres.TransactionSql,
  loc: SeededLocation,
  scenario: QaScenarioId,
): Promise<void> {
  const id = qaUuid(`sf:${scenario}:${loc.key}`);
  const J = (v: unknown) => tx.json(v as never);
  await tx`insert into storefront_briefs (
      id, org_id, location_id, status, has_no_site, pain_points, audience,
      voice, usp, submitted_at
    ) values (
      ${id}, ${loc.orgId}, ${loc.locationId}, 'submitted', true,
      ${J(['poor_mobile', 'no_booking_entry'])},
      ${J(['local_workers'])},
      'warm', 'Walk-ins and bookings on one board.', now()
    )`;
}

export async function openSupportRequest(
  tx: postgres.TransactionSql,
  loc: SeededLocation,
  scenario: QaScenarioId,
  statuses: Array<'open' | 'in_progress' | 'resolved'>,
  clock: QaClock,
): Promise<void> {
  const submitter = loc.people['owner'] ?? Object.values(loc.people)[0]!;
  for (const status of statuses) {
    const id = qaUuid(`sup:${scenario}:${loc.key}:${status}`);
    const resolvedAt = status === 'resolved' ? iso(clock.now) : null;
    await tx`insert into support_requests (
        id, org_id, location_id, submitted_by_user_id, submitted_by_membership_id,
        category, subject, description, status, priority, resolved_at
      ) values (
        ${id}, ${loc.orgId}, ${loc.locationId}, ${submitter.userId}, ${submitter.membershipId},
        'general', ${`QA ${status} request`},
        'Seed V2 support fixture. Status follows the support_requests check constraint.',
        ${status}, 'normal',
        ${resolvedAt}::timestamptz
      )`;
  }
}

export async function seedPlatformOperator(
  tx: postgres.TransactionSql,
  args: {
    scenario: QaScenarioId;
    email: string;
    fullName: string;
    role: 'super_admin' | 'support';
    status: 'active' | 'revoked';
    clock: QaClock;
  },
): Promise<{ userId: string; operatorId: string }> {
  const userId = await upsertQaAuthUser(args.email, args.fullName);
  await insertLocalAuthIdentity(tx, {
    userId, email: args.email, fullName: args.fullName,
  });
  await tx`insert into users (id, email, full_name, locale)
    values (${userId}, ${args.email}, ${args.fullName}, 'en')
    on conflict (id) do update set email = excluded.email, full_name = excluded.full_name`;
  const operatorId = qaUuid(`op:${args.scenario}`);
  const revokedAt = args.status === 'revoked'
    ? iso(new Date(args.clock.now.getTime() - 30 * 86_400_000))
    : null;
  await tx`insert into platform_operators (id, user_id, role, status, notes, revoked_at)
    values (
      ${operatorId}, ${userId}, ${args.role}, ${args.status},
      'qa-seed-v2', ${revokedAt}::timestamptz
    )`;
  return { userId, operatorId };
}

export async function recordClaimedSignup(
  tx: postgres.TransactionSql,
  tenant: SeededTenant,
  loc: SeededLocation,
  plan: string,
): Promise<void> {
  const owner = loc.people['owner'] ?? Object.values(loc.people)[0]!;
  await tx`insert into signup_intents (
      checkout_session_id, org_id, location_id, owner_email, plan, metadata,
      claimed_at, claimed_user_id, activation_email_sent_at
    ) values (
      ${`cs_test_qa_${tenant.scenario}`}, ${tenant.orgId}, ${loc.locationId},
      ${owner.email}, ${plan},
      ${tx.json({ qa_seed: 'v2', qa_scenario: tenant.scenario, stripe_mode: 'test' })},
      now(), ${owner.userId}, now()
    )`;
}
