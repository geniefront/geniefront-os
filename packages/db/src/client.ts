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

/**
 * 时间参数一律用这个转成 ISO 字符串，SQL 里配 `::timestamptz` 显式转型。
 *
 * 为什么不直接传 Date：postgres.js 的 inferType 靠 `x instanceof Date` 判类型
 * （见 postgres/src/types.js）。跨模块 realm 时这个检查会失败 —— vitest 把
 * 依赖放在 Node 原生 realm、测试代码放在 vite-node 的 VM realm，两边的 Date
 * 不是同一个构造函数，于是 Date 被当成未知类型原样写进字节流，报
 * "The string argument must be of type string... Received an instance of Date"。
 *
 * 显式转字符串顺带还有个好处：Postgres 不用猜参数类型，查询计划更稳。
 */
export const ts = (d: Date | string): string =>
  typeof d === 'string' ? d : d.toISOString();

/**
 * jsonb 参数同理，SQL 里配 `::jsonb`。
 *
 * 不能用 sql.json() —— 它返回 postgres.js 内部的 Parameter 实例，
 * inferType 靠 `x instanceof Parameter` 识别，跨 realm 一样会失效，
 * 报的是同一个错只是变成 "Received an instance of Object"。
 *
 * （packages/db 的 seed.ts 仍在用 sql.json：它只在 tsx 下跑，没有 realm 边界。
 *   运行时代码一律用这个函数。）
 */
export const jsonb = (v: unknown): string => JSON.stringify(v ?? null);

/**
 * 读回来的 timestamptz 也要显式解析。
 *
 * 实测在 Supavisor transaction mode + prepare:false 下，时间列返回的是
 * 字符串（形如 `2026-08-16 14:00:00+00`）而不是 Date 对象。
 * 别指望驱动帮你转 —— 拿到就当字符串处理，需要 Date 就过这个函数。
 *
 * Postgres 的输出有两处不是合法 ISO 8601，都要补：
 *   1. 日期和时间之间是空格，不是 'T'
 *   2. 时区偏移写成 `+00` 而不是 `+00:00` —— `new Date()` 认后者不认前者
 * 少补一处就是 Invalid Date。这里宁可抛错也不返回 NaN 日期：
 * 排期算错时间比直接失败难查得多。
 */
export function parseTs(v: string | Date): Date {
  if (typeof v !== 'string') return v;
  const iso = v
    .replace(' ', 'T')
    .replace(/([+-]\d{2})$/, '$1:00');
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`无法解析时间戳：${v}`);
  return d;
}

export async function closeDb(): Promise<void> {
  await sql.end({ timeout: 5 });
}
