import { PLAN_QUOTAS, TRIAL_QUOTA } from '@gf/payroll';
import { adminDatabaseSource, adminSql } from '../admin';
import { createQaClock } from './clock';
import { populateScenario } from './scenarios';
import { wipeQaTenants } from './reset';
import { QA_ALLOW_RESET_ENV, refuseUnlessQaSafe } from './safety';
import { snapshotQa } from './snapshot';
import { isQaScenarioId, QA_PASSWORD, QA_SCENARIO_IDS, type QaScenarioId, type QaSnapshot } from './types';

function safetyInput() {
  return {
    nodeEnv: process.env['NODE_ENV'],
    allowReset: process.env[QA_ALLOW_RESET_ENV],
    databaseTestTarget: process.env['DATABASE_TEST_TARGET'],
    databaseUrl: process.env['DATABASE_URL'],
    migrationDatabaseUrl: process.env['MIGRATION_DATABASE_URL'],
    supabaseUrl: process.env['SUPABASE_URL'],
    appUrl: process.env['APP_URL'],
    appBaseUrl: process.env['APP_BASE_URL'],
    adminDatabaseSource,
  };
}

export async function runQaReset(): Promise<{ host: string; database: string }> {
  const target = refuseUnlessQaSafe(safetyInput());
  await adminSql.begin(async (tx) => {
    await wipeQaTenants(tx);
  });
  return target;
}

export async function runQaSeed(scenario: string): Promise<{
  host: string;
  database: string;
  scenario: QaScenarioId;
  snapshot: QaSnapshot;
}> {
  if (!isQaScenarioId(scenario)) {
    throw new Error(`Unknown QA scenario '${scenario}'. Expected one of: ${QA_SCENARIO_IDS.join(', ')}`);
  }
  const target = refuseUnlessQaSafe(safetyInput());
  const clock = createQaClock();
  const snapshot = await adminSql.begin(async (tx) => {
    await wipeQaTenants(tx);
    await populateScenario(tx, scenario, clock);
    return snapshotQa(tx, scenario);
  });
  return { ...target, scenario, snapshot };
}

export async function runQaSeedTwice(scenario: QaScenarioId): Promise<{
  first: QaSnapshot;
  second: QaSnapshot;
}> {
  refuseUnlessQaSafe(safetyInput());
  const clock = createQaClock();
  const first = await adminSql.begin(async (tx) => {
    await wipeQaTenants(tx);
    await populateScenario(tx, scenario, clock);
    return snapshotQa(tx, scenario);
  });
  const second = await adminSql.begin(async (tx) => {
    await wipeQaTenants(tx);
    await populateScenario(tx, scenario, clock);
    return snapshotQa(tx, scenario);
  });
  return { first, second };
}

export function printSeedSummary(args: {
  scenario: QaScenarioId;
  host: string;
  database: string;
  snapshot: QaSnapshot;
}): void {
  console.log(`\n═══ Seed V2 · ${args.scenario} ═══`);
  console.log(`  db host     ${args.host}`);
  console.log(`  database    ${args.database}`);
  console.log(`  password    ${QA_PASSWORD}`);
  console.log(`  plan        ${args.snapshot.plan ?? '—'} / ${args.snapshot.subscriptionStatus ?? '—'}`);
  if (args.snapshot.trialEndsInFuture != null) {
    console.log(`  trial future ${args.snapshot.trialEndsInFuture}`);
  }
  console.log(`  orgs/locs   ${args.snapshot.orgCount}/${args.snapshot.locationCount}`);
  console.log(`  members     ${args.snapshot.membershipCount}`);
  console.log(`  logins      ${args.snapshot.loginEmails.join(', ') || '—'}`);
  console.log('');
}

export { PLAN_QUOTAS, TRIAL_QUOTA, QA_SCENARIO_IDS, isQaScenarioId };
