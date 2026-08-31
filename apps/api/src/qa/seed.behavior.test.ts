process.env['GF_QA_ALLOW_RESET'] = '1';
process.env['SEED_SKIP_AUTH'] = '1';
process.env['QA_NOW'] = '2026-08-30T16:00:00.000Z';

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { ERROR_CODES } from '@gf/contracts';
import { closeDb, withTenant } from '@gf/db';
import { buildContext } from '../actor';
import { dispatch } from '../bus';
import { requirePlatformOperator } from '../platform/auth';
import '../handlers/setup';
import '../handlers/billing';
import '../handlers/staff';
import { dispatchSystem } from '../test/systemDispatch';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

function qaUuid(seed: string): string {
  const hash = createHash('md5').update(`gf-qa-v2:${seed}`).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function qaEmail(local: string): string {
  return `qa+${local}@example.test`;
}

function seed(scenario: string): void {
  try {
    execFileSync('pnpm', ['qa:seed', scenario], {
      cwd: root,
      env: {
        ...process.env,
        GF_QA_ALLOW_RESET: '1',
        SEED_SKIP_AUTH: '1',
        QA_NOW: '2026-08-30T16:00:00.000Z',
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const detail = error as { stdout?: string; stderr?: string };
    throw new Error(`QA seed ${scenario} failed\n${detail.stdout ?? ''}\n${detail.stderr ?? ''}`.trim());
  }
}

afterAll(async () => {
  await closeDb();
});

async function ownerCtx(orgId: string, locationId: string, email: string) {
  const tenant = { orgId, locationId, membershipId: null };
  const [m] = await withTenant(tenant, (tx) => tx<{ id: string; user_id: string }[]>`
    select m.id, m.user_id from memberships m
    join users u on u.id = m.user_id
    where m.location_id = ${locationId} and lower(u.email) = ${email}
    limit 1`);
  return buildContext({ userId: m!.user_id, membershipId: m!.id });
}

describe('Seed V2 behavioral invariants', () => {
  it('past_due denies a normal business write and still allows billing.syncSubscription', async () => {
    seed('past_due');
    const orgId = qaUuid('org:past_due');
    const locationId = qaUuid('loc:past_due:main');
    const ctx = await ownerCtx(orgId, locationId, qaEmail('past_due'));

    await expect(dispatch('staff.setLocale', { locale: 'en' }, ctx)).rejects.toMatchObject({
      code: ERROR_CODES.SUBSCRIPTION_PAST_DUE,
    });

    const recovered = await dispatchSystem<{ subscriptionStatus: string }>(
      'billing.syncSubscription',
      { plan: 'growth', subscriptionStatus: 'active' },
      ctx,
    );
    expect(recovered.result.subscriptionStatus).toBe('active');
  });

  it('tech_only is denied settings.manage', async () => {
    seed('tech_only');
    const orgId = qaUuid('org:tech_only');
    const locationId = qaUuid('loc:tech_only:main');
    const ctx = await ownerCtx(orgId, locationId, qaEmail('tech_only'));
    expect(ctx.permissions.has('settings.manage')).toBe(false);
    expect(ctx.permissions.has('billing.manage')).toBe(false);
    expect(ctx.permissions.has('ticket.write')).toBe(true);
  });

  it('platform_operator session is allowed; shop owner and revoked operator are not', async () => {
    seed('platform_operator');
    const opsUser = qaUuid(`auth:${qaEmail('platform_operator')}`);
    const allowed = await requirePlatformOperator(opsUser);
    expect(allowed.role).toBe('super_admin');

    seed('revoked_platform_operator');
    const revokedUser = qaUuid(`auth:${qaEmail('revoked_platform_operator')}`);
    await expect(requirePlatformOperator(revokedUser)).rejects.toMatchObject({
      code: ERROR_CODES.PERMISSION_DENIED,
    });

    seed('owner');
    const ownerUser = qaUuid(`auth:${qaEmail('owner')}`);
    await expect(requirePlatformOperator(ownerUser)).rejects.toMatchObject({
      code: ERROR_CODES.PERMISSION_DENIED,
    });
  });
});
