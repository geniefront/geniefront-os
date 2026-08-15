/**
 * 数据库客户端与租户上下文。
 *
 * 唯一的业务读写入口是 withTenant()。它保证三件事：
 *   1. 永远在一个显式事务里 —— SET LOCAL 只在事务内有效
 *   2. 事务第一条语句就设好租户上下文 —— RLS 策略靠它
 *   3. 用受限角色 app_user 连库 —— 没有 BYPASSRLS
 *
 * 绕过它直接用 sql`` 查业务表 = RLS 会拒绝（因为 app.org_id 是 null），
 * 这是故意的：让错误用法立刻失败，而不是静默返回全部租户的数据。
 */

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema/index';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL 未设置');

/**
 * prepare: false —— Supavisor 的 transaction mode 下必须关掉预处理语句，
 * 否则连接被复用时会报 "prepared statement already exists"。
 */
export const sql = postgres(url, {
  max: Number(process.env.DB_POOL_MAX ?? 10),
  idle_timeout: 20,
  connect_timeout: 10,
  prepare: false,
});

export const db = drizzle(sql, { schema });
export type Db = typeof db;
export { schema };

export interface TenantContext {
  orgId: string;
  locationId: string | null;
  membershipId: string | null;
  /** 'staff_self' 让技师端只看得到自己的单（RLS 叠加策略） */
  roleScope?: 'full' | 'staff_self';
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 在租户上下文中执行一个事务。
 *
 * ⚠️ set_config 的第三个参数 true = local，等价于 SET LOCAL，事务结束自动清除。
 * 这里用 set_config 而不是拼 `SET LOCAL` 字符串，因为前者天然防注入 ——
 * orgId 是从 JWT 解出来的，但多一层保险不亏。
 */
export async function withTenant<T>(
  ctx: TenantContext,
  fn: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  if (!UUID_RE.test(ctx.orgId)) {
    throw new Error(`withTenant: orgId 不是合法 UUID：${ctx.orgId}`);
  }
  if (ctx.locationId !== null && !UUID_RE.test(ctx.locationId)) {
    throw new Error(`withTenant: locationId 不是合法 UUID：${ctx.locationId}`);
  }

  return sql.begin(async (tx) => {
    await tx`select set_config('app.org_id', ${ctx.orgId}, true)`;
    await tx`select set_config('app.location_id', ${ctx.locationId ?? ''}, true)`;
    await tx`select set_config('app.membership_id', ${ctx.membershipId ?? ''}, true)`;
    await tx`select set_config('app.role_scope', ${ctx.roleScope ?? 'full'}, true)`;
    return fn(tx);
  }) as Promise<T>;
}

/**
 * 仅供迁移与种子脚本使用 —— 不做租户隔离。
 * apps/** 里引用这个函数会被 scripts/lint-guards.sh 拦下。
 */
export async function unsafeAdminQuery<T>(fn: (s: postgres.Sql) => Promise<T>): Promise<T> {
  return fn(sql);
}

export async function closeDb(): Promise<void> {
  await sql.end({ timeout: 5 });
}
