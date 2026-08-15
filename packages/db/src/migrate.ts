/**
 * 迁移执行器。
 *
 * 两段：
 *   1. drizzle-kit 从 schema 生成的建表 SQL（./drizzle）
 *   2. 手写的守护 SQL（./sql）—— RLS、排他约束、审计 trigger
 *
 * 顺序不能反：先有表才能开 RLS。
 * 每个文件跑一次，记录在 _migrations 表里。
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adminSql } from './admin';

const here = dirname(fileURLToPath(import.meta.url));
const PKG = join(here, '..');

async function ensureLedger() {
  await adminSql`
    create table if not exists _migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )`;
}

async function applied(): Promise<Set<string>> {
  const rows = await adminSql<{ name: string }[]>`select name from _migrations`;
  return new Set(rows.map((r) => r.name));
}

async function runDir(dir: string, label: string, done: Set<string>): Promise<number> {
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  } catch {
    console.log(`  (${label}: 目录不存在，跳过)`);
    return 0;
  }

  let count = 0;
  for (const f of files) {
    const key = `${label}/${f}`;
    if (done.has(key)) {
      console.log(`  · ${key}  已应用`);
      continue;
    }
    const body = await readFile(join(dir, f), 'utf8');
    process.stdout.write(`  → ${key} ... `);
    try {
      // unsafe = 执行整个文件（多语句、DO 块、函数体里的 $$）
      await adminSql.unsafe(body);
      await adminSql`insert into _migrations ${adminSql({ name: key })}`;
      console.log('OK');
      count++;
    } catch (e) {
      console.log('失败');
      throw e;
    }
  }
  return count;
}

/**
 * app_user 需要能登录，但密码不该写进 .sql 文件（那些是要提交的）。
 * 所以角色在 SQL 里创建（NOLOGIN），密码在这里单独设。
 */
async function grantAppUserLogin() {
  const pw = process.env.APP_DB_PASSWORD;
  if (!pw) {
    console.log('\n⚠️  APP_DB_PASSWORD 未设置，跳过 app_user 登录配置');
    console.log('   应用将无法用受限角色连库 —— 生产环境必须设置。');
    return;
  }
  await adminSql.unsafe(
    `alter role app_user with login password '${pw.replace(/'/g, "''")}'`,
  );
  // Supavisor 走 pooler 时需要这个才能认到租户
  await adminSql`grant app_user to postgres`.catch(() => {});
  console.log('\n✓ app_user 已可登录（受 RLS 约束，无 BYPASSRLS）');
}

/**
 * 所有迁移跑完之后统一检查：带 org_id 的表必须都开了强制 RLS。
 *
 * 放在这里而不是某条迁移里，是因为迁移是【逐条】跑的 ——
 * 任何一条中间迁移看到的都是半成品状态，断言会误报。
 * 而且这样每次迁移都会重新检查一遍，新加的表漏开 RLS 当场就挡下来。
 */
async function assertRlsCoverage() {
  const missing = await adminSql<{ relname: string }[]>`
    select c.relname from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attname = 'org_id' and a.attnum > 0
    where n.nspname = 'public' and c.relkind = 'r'
      and not (c.relrowsecurity and c.relforcerowsecurity)
    order by c.relname`;
  if (missing.length > 0) {
    throw new Error(
      `这些表有 org_id 但没开强制 RLS：${missing.map((m) => m.relname).join(', ')}\n` +
      '补上 enable + force row level security 和 tenant_isolation 策略。',
    );
  }

  const noPolicy = await adminSql<{ relname: string }[]>`
    select c.relname from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attname = 'org_id' and a.attnum > 0
    where n.nspname = 'public' and c.relkind = 'r'
      and not exists (
        select 1 from pg_policy p where p.polrelid = c.oid and p.polname = 'tenant_isolation')
    order by c.relname`;
  if (noPolicy.length > 0) {
    throw new Error(`这些表开了 RLS 但没有 tenant_isolation 策略：${noPolicy.map((m) => m.relname).join(', ')}`);
  }
  console.log('✓ RLS 覆盖检查通过');
}

async function main() {
  console.log('\n═══ 迁移 ═══\n');
  const who = await adminSql<{ u: string; db: string }[]>`
    select current_user as u, current_database() as db`;
  console.log(`连接身份：${who[0]!.u} @ ${who[0]!.db}\n`);

  await ensureLedger();
  const done = await applied();

  console.log('1) 建表（drizzle）');
  const a = await runDir(join(PKG, 'drizzle'), 'drizzle', done);

  console.log('\n2) 守护 SQL（RLS / 约束 / 审计）');
  const b = await runDir(join(PKG, 'sql'), 'sql', done);

  await grantAppUserLogin();
  await assertRlsCoverage();

  console.log(`\n完成：新应用 ${a + b} 个文件\n`);
  await adminSql.end({ timeout: 5 });
}

main().catch(async (e) => {
  console.error('\n迁移失败：', e instanceof Error ? e.message : e);
  await adminSql.end({ timeout: 5 }).catch(() => {});
  process.exit(1);
});
