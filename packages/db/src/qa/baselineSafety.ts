export function assertBaselineTarget(target: string, env: Record<string, string | undefined>, config: {
  supabaseUrl: string; databaseHost: string; databasePort: string; databaseUser?: string;
}): void {
  if (target !== 'local' && target !== 'staging') throw new Error('Baseline seed is disabled in production');
  if (env['GF_ENV'] !== target) throw new Error('GF_ENV does not match requested seed environment');
  const url = new URL(env['MIGRATION_DATABASE_URL'] ?? '');
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== config.databaseHost || url.port !== config.databasePort
    || decodeURIComponent(url.username) !== (config.databaseUser ?? 'postgres')
    || url.pathname !== '/postgres' || env['SUPABASE_URL'] !== config.supabaseUrl) {
    throw new Error('Baseline seed database does not match the allowlisted environment');
  }
  if (env['COMMUNICATION_DELIVERY_MODE'] !== 'capture') throw new Error('Baseline seed requires capture delivery');
  if (!env['STRIPE_SECRET_KEY']?.startsWith('sk_test_')) throw new Error('Baseline seed requires Stripe test mode');
  if ((env['GF_BASELINE_PASSWORD']?.length ?? 0) < 20) throw new Error('GF_BASELINE_PASSWORD must contain at least 20 characters');
}
