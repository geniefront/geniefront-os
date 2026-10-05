/**
 * Production-refusal for QA reset/seed. Multiple independent checks.
 * Never log connection passwords.
 */

export const QA_ALLOW_RESET_ENV = 'GF_QA_ALLOW_RESET';
export const PRODUCTION_SUPABASE_REF = 'qiuyubvhirjtglonbkon';

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '0.0.0.0']);

const PRODUCTION_URL_MARKERS = [
  'api.geniefront.com',
  'desk.geniefront.com',
  'www.geniefront.com',
  'platform.geniefront.com',
  'geniefront.com',
  PRODUCTION_SUPABASE_REF,
];

export type QaSafetyInput = {
  nodeEnv?: string | undefined;
  allowReset?: string | undefined;
  databaseTestTarget?: string | undefined;
  databaseUrl?: string | undefined;
  migrationDatabaseUrl?: string | undefined;
  supabaseUrl?: string | undefined;
  appUrl?: string | undefined;
  appBaseUrl?: string | undefined;
  adminDatabaseSource?: 'process' | 'env-file' | undefined;
};

export type QaSafetyResult =
  | { ok: true; host: string; database: string }
  | { ok: false; reason: string };

function redact(url: string): { host: string; database: string } {
  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname,
      database: decodeURIComponent(parsed.pathname.replace(/^\//, '')) || '(none)',
    };
  } catch {
    return { host: '(unparseable)', database: '(unparseable)' };
  }
}

function looksLikePostgresUrl(value: string): boolean {
  return value.startsWith('postgres://') || value.startsWith('postgresql://');
}

function forbiddenMarker(value: string | undefined): string | null {
  if (!value) return null;
  const lower = value.toLowerCase();
  return PRODUCTION_URL_MARKERS.find((m) => lower.includes(m.toLowerCase())) ?? null;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Refuse QA reset/seed unless every independent check agrees this is
 * an isolated local/test database. Callers must pass explicit values;
 * do not read secrets inside the reason string.
 */
export function assertQaDatabaseSafe(input: QaSafetyInput): QaSafetyResult {
  const nodeEnv = (input.nodeEnv ?? '').toLowerCase();
  if (nodeEnv === 'production') {
    return { ok: false, reason: 'NODE_ENV=production is refused' };
  }
  if (nodeEnv && !['test', 'development', 'qa'].includes(nodeEnv)) {
    return { ok: false, reason: `NODE_ENV=${nodeEnv} is not a QA-allowed environment` };
  }

  if (input.allowReset !== '1') {
    return {
      ok: false,
      reason: `${QA_ALLOW_RESET_ENV} must be exactly 1 (explicit safety acknowledgment)`,
    };
  }

  if (input.databaseTestTarget !== 'isolated') {
    return { ok: false, reason: 'DATABASE_TEST_TARGET must be isolated' };
  }

  if (input.adminDatabaseSource === 'env-file') {
    return {
      ok: false,
      reason: 'MIGRATION_DATABASE_URL must be set explicitly in the process environment',
    };
  }

  const migrationUrl = input.migrationDatabaseUrl?.trim() ?? '';
  const databaseUrl = input.databaseUrl?.trim() ?? '';
  if (!migrationUrl || !looksLikePostgresUrl(migrationUrl)) {
    return { ok: false, reason: 'MIGRATION_DATABASE_URL must be a PostgreSQL URL' };
  }
  if (!databaseUrl || !looksLikePostgresUrl(databaseUrl)) {
    return { ok: false, reason: 'DATABASE_URL must be a PostgreSQL URL' };
  }

  for (const [label, value] of [
    ['MIGRATION_DATABASE_URL', migrationUrl],
    ['DATABASE_URL', databaseUrl],
    ['SUPABASE_URL', input.supabaseUrl],
    ['APP_URL', input.appUrl],
    ['APP_BASE_URL', input.appBaseUrl],
  ] as const) {
    const marker = forbiddenMarker(value);
    if (marker) {
      return { ok: false, reason: `${label} contains production marker ${marker}` };
    }
  }

  const migHost = hostOf(migrationUrl);
  const dbHost = hostOf(databaseUrl);
  if (!migHost || !LOCAL_HOSTS.has(migHost)) {
    return { ok: false, reason: 'MIGRATION_DATABASE_URL host is not a local test hostname' };
  }
  if (!dbHost || !LOCAL_HOSTS.has(dbHost)) {
    return { ok: false, reason: 'DATABASE_URL host is not a local test hostname' };
  }

  try {
    const mig = new URL(migrationUrl);
    const app = new URL(databaseUrl);
    if (mig.port === '55322' || app.port === '55322') {
      return { ok: false, reason: 'Manual QA local database (55322) is not an isolated scenario database' };
    }
    const migRole = decodeURIComponent(mig.username).split('.')[0];
    const appRole = decodeURIComponent(app.username).split('.')[0];
    if (migRole !== 'postgres') {
      return { ok: false, reason: 'MIGRATION_DATABASE_URL must use the postgres role' };
    }
    if (appRole !== 'app_user') {
      return { ok: false, reason: 'DATABASE_URL must use the app_user role' };
    }
    if (mig.toString() === app.toString()) {
      return { ok: false, reason: 'application and migration URLs must not be identical' };
    }
  } catch {
    return { ok: false, reason: 'database URLs could not be parsed' };
  }

  return { ok: true, ...redact(migrationUrl) };
}

export function refuseUnlessQaSafe(input: QaSafetyInput): { host: string; database: string } {
  const result = assertQaDatabaseSafe(input);
  if (!result.ok) {
    throw new Error(`QA reset/seed refused: ${result.reason}`);
  }
  return { host: result.host, database: result.database };
}
