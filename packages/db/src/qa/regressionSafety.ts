/** Legacy fixtures are confined to disposable local/CI databases, never manual-QA local. */
export function assertRegressionTarget(env: Record<string, string | undefined>): void {
  if (env['DATABASE_TEST_TARGET'] !== 'isolated' || env['NODE_ENV'] === 'production') {
    throw new Error('Legacy seed/setup reset requires an isolated test database');
  }
  for (const key of ['DATABASE_URL', 'MIGRATION_DATABASE_URL'] as const) {
    const url = new URL(env[key] ?? '');
    if (!['postgres:', 'postgresql:'].includes(url.protocol)
      || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      || url.port === '55322') {
      throw new Error('Legacy seed/setup reset refuses hosted databases and the manual-QA local database (55322)');
    }
    const role = key === 'DATABASE_URL' ? 'app_user' : 'postgres';
    if (decodeURIComponent(url.username) !== role) throw new Error(`Expected ${role} database role`);
  }
}
