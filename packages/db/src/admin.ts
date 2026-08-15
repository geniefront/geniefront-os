/**
 * 迁移与种子专用连接 —— 用 postgres 角色，不受 RLS 约束。
 *
 * ⚠️ 只有 migrate.ts / seed.ts 可以 import 这个文件。
 * apps/** 里出现它会被 scripts/lint-guards.sh 拦下。
 *
 * 业务读写一律走 client.ts 的 withTenant()。
 */

import postgres from 'postgres';

const url = process.env.MIGRATION_DATABASE_URL;
if (!url) {
  throw new Error(
    'MIGRATION_DATABASE_URL 未设置。这是 postgres 角色的连接串，只用于迁移；\n' +
    '应用运行时用的是 DATABASE_URL（app_user 角色，受 RLS 约束）。',
  );
}

export const adminSql = postgres(url, {
  max: 1,
  prepare: false,
  connect_timeout: 15,
  idle_timeout: 20,
  onnotice: (n) => {
    // 迁移是幂等的，"already exists" 这类 notice 是预期内的噪音
    if (!/already exists|skipping/i.test(n.message ?? '')) console.log(`  · ${n.message}`);
  },
});
