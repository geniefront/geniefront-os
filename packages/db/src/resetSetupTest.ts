/**
 * Create a fresh, paid-and-claimed onboarding tenant for repeatable setup tests.
 *
 * Previous runs are closed instead of deleted so payment/audit history remains
 * truthful. The test user always has exactly one active setup membership.
 */

import { assertRegressionTarget } from './qa/regressionSafety';
import { randomUUID } from 'node:crypto';
import { ROLE_PRESETS } from '@gf/contracts';
import { adminDatabaseSource, adminSql } from './admin';
import { createQaClock } from './qa/clock';
import { applyStripeSyncFixture } from './qa/stripeFixture';

const TEST_EMAIL = process.env.SETUP_TEST_EMAIL ?? 'setup@maildrop.cc';
const TEST_PASSWORD = process.env.SETUP_TEST_PASSWORD ?? 'GenieSetup!2026';
const TEST_NAME = 'Setup Test Owner';
const SUPABASE_URL = (process.env.SUPABASE_URL ?? '').replace(/\/$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

type AuthUser = { id: string; email?: string };

function requireEnvironment(): void {
  assertRegressionTarget(process.env);
  if (adminDatabaseSource !== 'process') {
    throw new Error('必须显式加载 MIGRATION_DATABASE_URL；请从仓库根目录运行 pnpm setup:test:reset。');
  }
  if (!SUPABASE_URL || !SERVICE_KEY) {
    throw new Error('缺少 SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY，请先补齐根目录 .env。');
  }
  if (!TEST_EMAIL.toLowerCase().endsWith('@maildrop.cc')) {
    throw new Error('SETUP_TEST_EMAIL 必须使用 @maildrop.cc，避免误重置真实用户。');
  }
  if (TEST_PASSWORD.length < 10) throw new Error('SETUP_TEST_PASSWORD 至少需要 10 个字符。');
}

async function authRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${SUPABASE_URL}/auth/v1${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });
  const body = await response.json().catch(() => ({})) as T & { message?: string; msg?: string };
  if (!response.ok) {
    throw new Error(`Supabase Auth ${response.status}: ${body.message ?? body.msg ?? '请求失败'}`);
  }
  return body;
}

async function ensureAuthUser(): Promise<AuthUser> {
  const found = await authRequest<{ users?: AuthUser[] }>(
    `/admin/users?filter=${encodeURIComponent(TEST_EMAIL)}`,
  );
  const existing = found.users?.find((user) => user.email?.toLowerCase() === TEST_EMAIL.toLowerCase());
  const payload = {
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
    email_confirm: true,
    user_metadata: { full_name: TEST_NAME },
  };
  if (existing) {
    await authRequest(`/admin/users/${existing.id}`, {
      method: 'PUT', body: JSON.stringify(payload),
    });
    return existing;
  }
  return authRequest<AuthUser>('/admin/users', {
    method: 'POST', body: JSON.stringify(payload),
  });
}

async function createFreshSetup(authUser: AuthUser): Promise<{ locationId: string; membershipId: string }> {
  const runId = randomUUID();
  const shortId = runId.replace(/-/g, '').slice(0, 12);
  const checkoutSession = `cs_test_setup_${runId}`;

  return adminSql.begin(async (tx) => {
    // Archive only tenants created by this utility. No real shop can match both
    // the marker and the enforced @maildrop.cc owner email.
    const previous = await tx<{ org_id: string; location_id: string }[]>`
      select org_id, location_id from signup_intents
      where lower(owner_email) = lower(${TEST_EMAIL})
        and metadata->>'setup_test_account' = 'true'`;
    const previousLocations = previous.map((row) => row.location_id);
    if (previousLocations.length > 0) {
      await tx`update memberships set status = 'left', ended_on = current_date
        where location_id = any(${previousLocations})`;
      await tx`update locations set status = 'closed', updated_at = now()
        where id = any(${previousLocations})`;
      await tx`update billing_accounts set subscription_status = 'canceled'
        where location_id = any(${previousLocations})`;
    }

    const [tenant] = await tx<{ org_id: string; location_id: string }[]>`
      select org_id, location_id from gf_provision_tenant(
        ${checkoutSession}, 'Setup Test Shop', ${TEST_EMAIL}, 'nail',
        'America/New_York', 'zh-Hans', 'growth', null,
        ${tx.json({
          setup_test_account: true,
          stripe_payment_status: 'paid',
          stripe_mode: 'test',
          setup_test_run: runId,
        })}::jsonb
      )`;
    if (!tenant) throw new Error('创建 setup 测试门店失败。');

    await tx`
      insert into users (id, email, full_name, locale)
      values (${authUser.id}, ${TEST_EMAIL}, ${TEST_NAME}, 'zh-Hans')
      on conflict (id) do update
      set email = excluded.email, full_name = excluded.full_name, locale = excluded.locale`;

    let ownerRoleId: string | null = null;
    for (const [key, permissions] of Object.entries(ROLE_PRESETS)) {
      const [role] = await tx<{ id: string }[]>`
        insert into roles (org_id, location_id, key, name, is_preset)
        values (${tenant.org_id}, ${tenant.location_id}, ${key},
                ${tx.json({ en: key })}, true)
        returning id`;
      if (key === 'owner') ownerRoleId = role!.id;
      for (const permission of permissions) {
        await tx`insert into role_permissions (role_id, permission)
          values (${role!.id}, ${permission})`;
      }
    }
    if (!ownerRoleId) throw new Error('owner 角色预设不存在。');

    const [membership] = await tx<{ id: string }[]>`
      insert into memberships (org_id, location_id, user_id, status, started_on)
      values (${tenant.org_id}, ${tenant.location_id}, ${authUser.id}, 'active', current_date)
      returning id`;
    await tx`insert into membership_roles (membership_id, role_id)
      values (${membership!.id}, ${ownerRoleId})`;
    await tx`insert into staff_profiles
      (membership_id, org_id, location_id, display_name, is_bookable, max_concurrent_appointments)
      values (${membership!.id}, ${tenant.org_id}, ${tenant.location_id},
              ${tx.json({ en: TEST_NAME, 'zh-Hans': 'Setup 测试老板' })}, false, 1)`;

    await tx`update organizations
      set owner_user_id = ${authUser.id}, updated_at = now()
      where id = ${tenant.org_id}`;
    await tx`update signup_intents
      set claimed_at = now(), claimed_user_id = ${authUser.id}, activation_email_sent_at = now()
      where checkout_session_id = ${checkoutSession}`;
    await applyStripeSyncFixture(tx, {
      orgId: tenant.org_id,
      locationId: tenant.location_id,
      plan: 'growth',
      subscriptionStatus: 'active',
      clock: createQaClock(),
      scenarioKey: `setup-test-${shortId}`,
    });
    await tx`insert into user_last_location (user_id, location_id, at)
      values (${authUser.id}, ${tenant.location_id}, now())
      on conflict (user_id) do update
      set location_id = excluded.location_id, at = excluded.at`;

    return { locationId: tenant.location_id, membershipId: membership!.id };
  });
}

async function main(): Promise<void> {
  requireEnvironment();
  console.log('\n═══ 重置 Setup 测试账号 ═══\n');
  const authUser = await ensureAuthUser();
  if (!authUser.id) throw new Error('Supabase Auth 未返回用户 ID。');
  const fresh = await createFreshSetup(authUser);
  console.log(`  ✓ 账号：${TEST_EMAIL}`);
  console.log(`  ✓ 密码：${TEST_PASSWORD}`);
  console.log('  ✓ 付款：Stripe test / active / Growth');
  console.log('  ✓ 状态：已认领、未完成 setup');
  console.log(`  ✓ 新门店：${fresh.locationId}`);
  console.log(`  ✓ 新身份：${fresh.membershipId}`);
  console.log('\n  现在登录 Web，会自动进入 /setup。再次运行本命令即可从头再测。\n');
}

main()
  .catch((error) => {
    console.error(`\n✗ ${(error as Error).message}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await adminSql.end({ timeout: 5 });
  });
