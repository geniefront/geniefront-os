/**
 * Every API integration suite starts from the same deterministic seed.
 *
 * These suites exercise real transactions and intentionally mutate data. A
 * single shared seed makes later files depend on which file ran first (for
 * example, staff.test parks all current-day records). The Vitest database guard
 * has already proved that TEST_* points at an isolated database before this
 * setup file can run.
 */
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.env['DATABASE_TEST_TARGET'] !== 'isolated') {
  throw new Error('拒绝重置数据库：API 集成测试必须使用 isolated test database');
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

try {
  execFileSync('pnpm', ['--dir', root, 'db:seed'], {
    env: {
      ...process.env,
      SEED_SKIP_AUTH: '1',
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
} catch (error) {
  const detail = error as { stdout?: string; stderr?: string };
  throw new Error(
    `API 测试种子重置失败\n${detail.stdout ?? ''}\n${detail.stderr ?? ''}`.trim(),
  );
}
