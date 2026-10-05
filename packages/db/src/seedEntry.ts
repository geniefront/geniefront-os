/** Explicit manual-QA environment, or the existing isolated CI regression path. */
const target = process.argv[2];
if (target === 'local' || target === 'staging') {
  await import('./baselineSeed');
} else if (!target && process.env['DATABASE_TEST_TARGET'] === 'isolated') {
  await import('./seed');
} else {
  throw new Error('Usage: pnpm db:seed <local|staging>. Production seeding is disabled; regression requires an isolated test database.');
}
export {};
