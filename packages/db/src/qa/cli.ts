import { applyQaEnv } from './env';

applyQaEnv();
if (
  !process.env['SEED_SKIP_AUTH']
  && !process.env['SUPABASE_URL']
  && !process.env['TEST_SUPABASE_URL']
) {
  process.env['SEED_SKIP_AUTH'] = '1';
}

const { QA_SCENARIO_IDS, printSeedSummary, runQaReset, runQaSeed } = await import('./runner');

const [, , cmd, scenario] = process.argv;

try {
  if (cmd === 'reset') {
    const r = await runQaReset();
    console.log(`\n═══ QA reset ═══`);
    console.log(`  db host   ${r.host}`);
    console.log(`  database  ${r.database}`);
    console.log('  Seed V2 tenants removed. Lotus/Golden Foot regression seed was not touched.\n');
  } else if (cmd === 'seed') {
    if (!scenario) {
      throw new Error(`Usage: qa:seed <scenario>\n  scenarios: ${QA_SCENARIO_IDS.join(', ')}`);
    }
    const r = await runQaSeed(scenario);
    printSeedSummary(r);
  } else {
    throw new Error('Usage: qa:reset | qa:seed <scenario>');
  }
} catch (error) {
  const err = error as Error & { query?: string };
  console.error(`\n✗ ${err.message}`);
  if (err.query) console.error(`  SQL: ${err.query}`);
  console.error('');
  process.exitCode = 1;
} finally {
  const { adminSql } = await import('../admin');
  await adminSql.end({ timeout: 5 }).catch(() => {});
}
