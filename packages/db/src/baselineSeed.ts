/** Minimal persistent manual-QA baseline. Never resets data or runs in production. */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertBaselineTarget } from './qa/baselineSafety';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const target = process.argv[2];
if (target !== 'local' && target !== 'staging') throw new Error('Usage: db:seed <local|staging>; production seed is disabled');
const config = JSON.parse(readFileSync(resolve(root, 'config/test-accounts.json'), 'utf8'))[target] as {
  supabaseUrl: string; databaseHost: string; databasePort: string; databaseUser?: string;
  owner: string; frontDesk: string; tech: string; setup: string; operator: string;
};
const env: Record<string, string> = {};
for (const line of readFileSync(resolve(root, `.env.${target}`), 'utf8').split('\n')) {
  const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
  if (m) env[m[1]!] = m[2]!.trim().replace(/^["']|["']$/g, '');
}
assertBaselineTarget(target, env, config);
Object.assign(process.env, env, { SEED_SKIP_AUTH: '1' });
const { adminSql } = await import('./admin');
const { bootstrapTenant } = await import('./qa/bootstrap');
const { seedCatalog, seedTodayShifts } = await import('./qa/shopData');
const { createQaClock } = await import('./qa/clock');
const { applyStripeSyncFixture } = await import('./qa/stripeFixture');
const marker = `baseline-${target}-v1`;
const emails = [config.owner, config.frontDesk, config.tech, config.setup];
try {
  await adminSql.begin(async tx => {
    await tx`select pg_advisory_xact_lock(hashtext(${marker}))`;
    const admins = await tx`select a.id from auth.users a join platform_operators p on p.user_id=a.id where a.email=${config.operator} and p.role='super_admin' and p.status='active'`;
    if (admins.length !== 1) throw new Error('Expected preserved administrator is missing; refusing to create a replacement');
    const existing = await tx`select id from locations where settings->>'baseline_seed' = ${marker}`;
    if (existing.length) {
      const [{ n } = { n: 0 }] = await tx`select count(*)::int as n from auth.users where email = any(${emails})`;
      if (existing.length !== 2 || n !== 4) throw new Error('Partial baseline detected; refusing to overwrite existing data');
      console.log(`${target}: baseline already exists; preserved current test data`);
      return;
    }
    const collisions = await tx`select email from auth.users where email = any(${emails})`;
    if (collisions.length) throw new Error('Baseline email collision; refusing to overwrite an existing account');
    const clock = createQaClock();
    for (const mode of ['operations', 'setup'] as const) {
      const scenario = `${marker}-${mode}`;
      const ownerEmail = mode === 'operations' ? config.owner : config.setup;
      const staff = [{ key: 'owner', email: ownerEmail, fullName: `QA ${target} ${mode} owner`, roles: ['owner'] as ['owner'], bookable: false },
        ...(mode === 'operations' ? [
          { key: 'front_desk', email: config.frontDesk, fullName: 'QA Front Desk', roles: ['front_desk'] as ['front_desk'], bookable: false },
          { key: 'tech', email: config.tech, fullName: 'QA Technician', roles: ['tech'] as ['tech'], bookable: true },
        ] : [])];
      const tenant = await bootstrapTenant(tx, {
        scenario, orgName: `QA ${target} ${mode}`, ownerKey: 'owner', authPassword: env['GF_BASELINE_PASSWORD']!, plan: 'growth',
        locations: [{ key: 'main', nameEn: `QA ${target} ${mode}`, nameZh: `${target} ${mode === 'operations' ? '运营测试店' : '开店测试店'}`,
          slug: `qa-${target}-${mode}`, timezone: 'America/New_York', businessType: 'nail', cutoff: '04:00',
          status: mode === 'operations' ? 'active' : 'setup', staff }],
      });
      const loc = tenant.locations['main']!;
      await tx`update locations set settings = (settings - 'qa_seed' - 'qa_scenario') || ${tx.json({ baseline_seed: marker, test_account: true })} where id = ${loc.locationId}`;
      await applyStripeSyncFixture(tx, { orgId: loc.orgId, locationId: loc.locationId, plan: 'growth', subscriptionStatus: mode === 'operations' ? 'active' : 'trialing', clock, scenarioKey: scenario });
      if (mode === 'operations') {
        await seedCatalog(tx, loc, scenario, [{ key: 'guest', name: 'QA Test Guest', phone: '+12025550101' }]);
        await seedTodayShifts(tx, loc, clock);
        for (let weekday = 0; weekday < 7; weekday++) {
          await tx`insert into shift_templates (org_id,location_id,membership_id,weekday,start_min,end_min,break_min,active)
            values (${loc.orgId},${loc.locationId},${loc.people['tech']!.membershipId},${weekday},570,1170,0,true)`;
        }
      }
    }
    console.log(`${target}: created 4 test logins, 2 shops; preserved existing operator; password stored in .env.${target} (GF_BASELINE_PASSWORD)`);
  });
} finally { await adminSql.end({ timeout: 5 }); }
