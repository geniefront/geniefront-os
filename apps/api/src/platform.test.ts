/**
 * Platform operator console: authorization, cross-tenant reads, audit,
 * and the billing mutation freeze. Customer tenant isolation stays intact.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { AppError, ERROR_CODES } from '@gf/contracts';
import {
  closeDb, withTenant, withUser,
  PLATFORM_OPS_USER_ID, PLATFORM_EXOPS_USER_ID,
} from '@gf/db';
import { buildContext } from './actor';
import { dispatch } from './bus';
import { issueStaffSession, STAFF_TOKEN_HEADER } from './auth/staffSession';

const OWNER_USER = '196f0ab4-cd94-45cc-8109-2c414e966828';
const NAIL_ORG = '11111111-1111-4111-8111-111111111111';
const SPA_ORG = '22222222-2222-4222-8222-222222222222';
const NAIL_LOC = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const SPA_LOC = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

const authUser = {
  userId: '' as string,
  email: undefined as string | undefined,
};

vi.mock('./auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./auth')>();
  return {
    ...actual,
    verifyAccessToken: vi.fn(async () => {
      if (!authUser.userId) throw new AppError(ERROR_CODES.UNAUTHENTICATED);
      return { userId: authUser.userId, email: authUser.email };
    }),
  };
});

const { buildServer } = await import('./server');

let app: ReturnType<typeof buildServer>;
let ownerMembershipId: string;
let staffToken: string;

beforeAll(async () => {
  const [owner] = await withTenant(
    { orgId: SPA_ORG, locationId: SPA_LOC, membershipId: null },
    (tx) => tx<{ id: string }[]>`
      select m.id from memberships m
      join membership_roles mr on mr.membership_id = m.id
      join roles r on r.id = mr.role_id
      where m.user_id = ${OWNER_USER} and r.key = 'owner' limit 1`);
  ownerMembershipId = owner!.id;

  const session = await issueStaffSession(
    { orgId: SPA_ORG, locationId: SPA_LOC, membershipId: ownerMembershipId },
    'claim_code',
    'platform_test',
  );
  staffToken = session.token;

  app = buildServer();
  await app.ready();
});

afterAll(async () => {
  if (app) await app.close();
  await closeDb();
});

function asUser(userId: string, email?: string) {
  authUser.userId = userId;
  authUser.email = email;
}

function asAnon() {
  authUser.userId = '';
  authUser.email = undefined;
}

describe('platform API authorization', () => {
  it('1. unauthenticated user cannot access platform API', async () => {
    asAnon();
    const r = await app.inject({ method: 'GET', url: '/v1/platform/session' });
    expect(r.statusCode).toBe(401);
    expect(r.json().code).toBe('UNAUTHENTICATED');
  });

  it('2. authenticated store owner cannot access platform API', async () => {
    asUser(OWNER_USER, 'owner@example.test');
    const r = await app.inject({ method: 'GET', url: '/v1/platform/session' });
    expect(r.statusCode).toBe(403);
    expect(r.json().code).toBe('PERMISSION_DENIED');
    expect(r.json().details.reason).toBe('not_platform_operator');
  });

  it('revoked operator cannot access platform API', async () => {
    asUser(PLATFORM_EXOPS_USER_ID, 'exops@geniefront.test');
    const r = await app.inject({ method: 'GET', url: '/v1/platform/stores' });
    expect(r.statusCode).toBe(403);
    expect(r.json().details.reason).toBe('not_platform_operator');
  });

  it('staff token is not platform authorization', async () => {
    asAnon();
    const r = await app.inject({
      method: 'GET',
      url: '/v1/platform/session',
      headers: { [STAFF_TOKEN_HEADER]: staffToken },
    });
    expect(r.statusCode).toBe(401);
  });

  it('3. authorized platform operator can access platform', async () => {
    asUser(PLATFORM_OPS_USER_ID, 'ops@geniefront.test');
    const r = await app.inject({ method: 'GET', url: '/v1/platform/session' });
    expect(r.statusCode).toBe(200);
    expect(r.json().operator.role).toBe('super_admin');
    expect(r.json().operator.userId).toBe(PLATFORM_OPS_USER_ID);
  });
});

describe('platform cross-tenant reads', () => {
  it('4. operator can query multiple stores only through platform endpoints', async () => {
    asUser(PLATFORM_OPS_USER_ID, 'ops@geniefront.test');
    const r = await app.inject({ method: 'GET', url: '/v1/platform/stores?q=' });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { total: number; items: Array<{ orgId: string; locationId: string }> };
    expect(body.total).toBeGreaterThanOrEqual(2);
    const orgs = new Set(body.items.map((i) => i.orgId));
    expect(orgs.has(NAIL_ORG)).toBe(true);
    expect(orgs.has(SPA_ORG)).toBe(true);
  });

  it('owner search by email does not grant platform access', async () => {
    asUser(OWNER_USER, 'owner@example.test');
    const r = await app.inject({ method: 'GET', url: '/v1/platform/stores?q=lotus' });
    expect(r.statusCode).toBe(403);
  });

  it('5. normal customer endpoints remain tenant isolated', async () => {
    const spaCustomers = await withTenant(
      { orgId: SPA_ORG, locationId: SPA_LOC, membershipId: null },
      (tx) => tx<{ id: string }[]>`select id from customers limit 1`);
    const peek = await withTenant(
      { orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: null },
      (tx) => tx`select id from customers where id = ${spaCustomers[0]!.id}`);
    expect(peek.length).toBe(0);
  });

  it('10. arbitrary tenant id from a non-platform user does not become cross-tenant access', async () => {
    asUser(OWNER_USER, 'owner@example.test');
    const r = await app.inject({
      method: 'GET',
      url: `/v1/platform/stores/${SPA_LOC}`,
    });
    expect(r.statusCode).toBe(403);

    const nailPeek = await withTenant(
      { orgId: SPA_ORG, locationId: SPA_LOC, membershipId: ownerMembershipId, userId: OWNER_USER },
      (tx) => tx`select id from locations where id = ${NAIL_LOC}`);
    expect(nailPeek.length).toBe(0);
  });
});

describe('platform billing is read-only for paid state', () => {
  it('6. platform billing view does not mutate subscription paid state', async () => {
    asUser(PLATFORM_OPS_USER_ID, 'ops@geniefront.test');
    await withTenant(
      { orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: null },
      (tx) => tx`
        insert into billing_accounts (
          org_id, location_id, plan, subscription_status, stripe_customer_id, credit_balance
        ) values (
          ${NAIL_ORG}, ${NAIL_LOC}, 'essential', 'trialing', 'cus_test_platform', 0
        )
        on conflict (location_id) do update set
          plan = excluded.plan,
          subscription_status = excluded.subscription_status`);
    const before = await withTenant(
      { orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: null },
      (tx) => tx<{ plan: string; subscription_status: string; credit_balance: number }[]>`
        select plan, subscription_status, credit_balance from billing_accounts
        where location_id = ${NAIL_LOC}`);

    const r = await app.inject({ method: 'GET', url: `/v1/platform/stores/${NAIL_LOC}` });
    expect(r.statusCode).toBe(200);
    const billing = r.json().billing as { plan: string; subscriptionStatus: string } | null;
    expect(billing).toBeTruthy();
    expect(billing!.plan).toBe(before[0]!.plan);
    expect(billing!.subscriptionStatus).toBe(before[0]!.subscription_status);
    expect(r.json()).not.toHaveProperty('setActive');

    const after = await withTenant(
      { orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: null },
      (tx) => tx<{ plan: string; subscription_status: string; credit_balance: number }[]>`
        select plan, subscription_status, credit_balance from billing_accounts
        where location_id = ${NAIL_LOC}`);
    expect(after[0]).toEqual(before[0]);
  });

  it('7. platform cannot invoke disabled local billing.changePlan / billing.buyAddon', async () => {
    asUser(PLATFORM_OPS_USER_ID, 'ops@geniefront.test');
    const missingChange = await app.inject({
      method: 'POST',
      url: `/v1/platform/stores/${NAIL_LOC}/billing/change-plan`,
      payload: { targetPlan: 'growth' },
    });
    expect(missingChange.statusCode).toBe(404);

    const missingBuy = await app.inject({
      method: 'POST',
      url: `/v1/platform/stores/${NAIL_LOC}/billing/buy-addon`,
      payload: { addon: 'credits' },
    });
    expect(missingBuy.statusCode).toBe(404);

    const ctx = await buildContext({ userId: OWNER_USER, membershipId: ownerMembershipId });
    await expect(dispatch('billing.changePlan', { targetPlan: 'growth' }, ctx)).rejects.toMatchObject({
      details: { reason: 'use_checkout_or_portal', command: 'billing.changePlan' },
    });
    await expect(dispatch('billing.buyAddon', { addonType: 'voice_minutes_100', priceCents: 2500 }, ctx)).rejects.toMatchObject({
      details: { reason: 'use_checkout_or_portal', command: 'billing.buyAddon' },
    });
  });
});

describe('platform mutations are audited', () => {
  it('8. 10DLC internal review changes are audited', async () => {
    await withTenant(
      { orgId: SPA_ORG, locationId: SPA_LOC, membershipId: ownerMembershipId, userId: OWNER_USER },
      async (tx) => {
        await tx`
          insert into location_10dlc_registrations (
            location_id, status, legal_business_name, ein, submitted_at,
            submitted_by_membership_id, updated_at
          ) values (
            ${SPA_LOC}, 'pending_review', 'Golden Foot Spa LLC', '12-3456789', now(),
            ${ownerMembershipId}, now()
          )
          on conflict (location_id) do update set
            status = 'pending_review',
            submitted_at = now(),
            updated_at = now()`;
      },
    );

    asUser(PLATFORM_OPS_USER_ID, 'ops@geniefront.test');
    const r = await app.inject({
      method: 'POST',
      url: `/v1/platform/10dlc/${SPA_LOC}/review`,
      payload: { action: 'approve_internal', notes: 'docs look complete' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().status).toBe('approved');
    expect(r.json().reviewKind).toBe('internal_geniefront');
    expect(JSON.stringify(r.json())).not.toMatch(/tcr|telnyx|carrier/i);

    const audit = await withTenant(
      { orgId: SPA_ORG, locationId: SPA_LOC, membershipId: null },
      (tx) => tx<{ command: string; actor_kind: string; after: Record<string, unknown> }[]>`
        select command, actor_kind, after from audit_log
        where command = 'platform.review10Dlc' and location_id = ${SPA_LOC}
        order by at desc limit 1`);
    expect(audit[0]?.actor_kind).toBe('platform');
    expect(audit[0]?.after['status']).toBe('approved');
    expect(audit[0]?.after['carrierSubmitted']).toBe(false);
    expect(audit[0]?.after['operatorUserId']).toBe(PLATFORM_OPS_USER_ID);
  });

  it('9. support-request mutations are audited', async () => {
    const ctx = await buildContext({ userId: OWNER_USER, membershipId: ownerMembershipId });
    const created = await dispatch<{ requestId: string }>(
      'support.submitRequest',
      { category: 'billing', subject: 'Card failed', description: 'Past due after retry.' },
      ctx,
    );

    asUser(PLATFORM_OPS_USER_ID, 'ops@geniefront.test');
    const r = await app.inject({
      method: 'PATCH',
      url: `/v1/platform/support-requests/${created.result.requestId}`,
      payload: { status: 'in_progress' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().status).toBe('in_progress');

    const audit = await withTenant(
      { orgId: SPA_ORG, locationId: SPA_LOC, membershipId: null },
      (tx) => tx<{ command: string; actor_kind: string; after: Record<string, unknown> }[]>`
        select command, actor_kind, after from audit_log
        where command = 'platform.updateSupportRequest'
          and entity_id = ${created.result.requestId}
        order by at desc limit 1`);
    expect(audit[0]?.actor_kind).toBe('platform');
    expect(audit[0]?.after['status']).toBe('in_progress');
    expect(audit[0]?.after['operatorUserId']).toBe(PLATFORM_OPS_USER_ID);
  });

  it('11. no secrets/tokens are returned unnecessarily', async () => {
    asUser(PLATFORM_OPS_USER_ID, 'ops@geniefront.test');
    const r = await app.inject({ method: 'GET', url: `/v1/platform/stores/${NAIL_LOC}` });
    expect(r.statusCode).toBe(200);
    const body = JSON.stringify(r.json());
    expect(body).not.toMatch(/pin_hash|pinHash|token_hash|tokenHash|claim_code|secret|SERVICE_ROLE/i);
    const people = r.json().people as Array<Record<string, unknown>>;
    for (const person of people) {
      expect(person).not.toHaveProperty('pinHash');
      expect(person).not.toHaveProperty('claimCodeHash');
    }
  });
});

describe('dashboard counts are real queries', () => {
  it('returns the documented counters', async () => {
    asUser(PLATFORM_OPS_USER_ID, 'ops@geniefront.test');
    const r = await app.inject({ method: 'GET', url: '/v1/platform/dashboard' });
    expect(r.statusCode).toBe(200);
    const body = r.json() as Record<string, number>;
    for (const key of [
      'activeStores', 'trialStores', 'pastDueStores', 'setupIncomplete',
      'openSupport', 'pending10Dlc', 'websiteRequests',
    ]) {
      expect(typeof body[key]).toBe('number');
    }
  });
});

describe('identity mode is not a platform backdoor', () => {
  it('withUser as owner still cannot read other orgs\' customers', async () => {
    const rows = await withUser(OWNER_USER, (tx) =>
      tx<{ n: number }[]>`select count(*)::int as n from customers`);
    expect(rows[0]!.n).toBe(0);
  });
});
