/**
 * RLS 隔离测试 —— Phase 0 验收的核心。
 *
 * 这些测试用 app_user 连库（DATABASE_URL），不是 postgres。
 * 如果哪天有人把应用改成用 service_role 连库，这些测试会**全部通过但毫无意义** ——
 * 所以第一个测试就是断言「当前连接身份是 app_user」。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql, withTenant, closeDb } from './client';

const NAIL_ORG = '11111111-1111-4111-8111-111111111111';
const SPA_ORG  = '22222222-2222-4222-8222-222222222222';
const NAIL_LOC = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';

beforeAll(async () => {
  const [row] = await sql<{ u: string }[]>`select current_user as u`;
  if (row?.u !== 'app_user') {
    throw new Error(
      `测试必须用 app_user 连库，当前是 ${row?.u}。\n` +
      `用 postgres 跑这些测试会全部通过但证明不了任何事。`,
    );
  }
});

afterAll(async () => { await closeDb(); });

describe('租户隔离', () => {
  it('连接身份是受限角色 app_user，且没有 BYPASSRLS', async () => {
    const [r] = await sql<{ u: string; bypass: boolean }[]>`
      select current_user as u,
             (select rolbypassrls from pg_roles where rolname = current_user) as bypass`;
    expect(r?.u).toBe('app_user');
    expect(r?.bypass).toBe(false);
  });

  it('在 org A 的上下文里只看得到 org A 的门店', async () => {
    const rows = await withTenant({ orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: null },
      (tx) => tx<{ id: string; org_id: string }[]>`select id, org_id from locations`);
    expect(rows.length).toBe(1);
    expect(rows[0]!.org_id).toBe(NAIL_ORG);
  });

  it('⭐ 拿着 org B 的 id 去查 org A 的门店 → 查不到（不是报错，是查不到）', async () => {
    const rows = await withTenant({ orgId: SPA_ORG, locationId: null, membershipId: null },
      (tx) => tx`select id from locations where id = ${NAIL_LOC}`);
    expect(rows.length).toBe(0);
  });

  it('顾客数据不跨 org 泄露', async () => {
    const nail = await withTenant({ orgId: NAIL_ORG, locationId: null, membershipId: null },
      (tx) => tx<{ n: number }[]>`select count(*)::int as n from customers`);
    const spa = await withTenant({ orgId: SPA_ORG, locationId: null, membershipId: null },
      (tx) => tx<{ n: number }[]>`select count(*)::int as n from customers`);
    expect(nail[0]!.n).toBe(3);
    expect(spa[0]!.n).toBe(1);
  });

  it('没有租户上下文时什么也查不到（而不是查到全部）', async () => {
    const rows = await sql`select id from locations`;
    expect(rows.length).toBe(0);
  });

  it('不能往别人的 org 里写数据（with check 拦住）', async () => {
    await expect(
      withTenant({ orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: null }, (tx) =>
        tx`insert into customers (org_id, display_name, source)
           values (${SPA_ORG}, 'smuggled', 'walkin')`),
    ).rejects.toThrow(/row-level security/i);
  });
});

describe('宪法第 17 条：audit_log append-only', () => {
  it('可以插入', async () => {
    const rows = await withTenant({ orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: null },
      (tx) => tx<{ id: string }[]>`
        insert into audit_log (org_id, location_id, command, actor_kind)
        values (${NAIL_ORG}, ${NAIL_LOC}, 'test.write', 'system') returning id`);
    expect(rows[0]!.id).toBeTruthy();
  });

  it('⭐ 改不了', async () => {
    await expect(
      withTenant({ orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: null },
        (tx) => tx`update audit_log set command = 'tampered' where org_id = ${NAIL_ORG}`),
    ).rejects.toThrow(/append-only|permission denied/i);
  });

  it('⭐ 删不掉', async () => {
    await expect(
      withTenant({ orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: null },
        (tx) => tx`delete from audit_log where org_id = ${NAIL_ORG}`),
    ).rejects.toThrow(/append-only|permission denied/i);
  });
});

describe('宪法第 5 条：新表不许漏开 RLS', () => {
  it('⭐ 所有带 org_id 的表都开了 enable + force RLS', async () => {
    const rows = await sql<{ relname: string }[]>`
      select c.relname from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attname = 'org_id' and a.attnum > 0
      where n.nspname = 'public' and c.relkind = 'r'
        and not (c.relrowsecurity and c.relforcerowsecurity)
      order by c.relname`;
    // 新建业务表默认没有 RLS。这条测试就是防「加了表忘了开」——
    // 那种错在开发期毫无症状，直到线上串了租户数据才发现。
    expect(rows.map((r) => r.relname)).toEqual([]);
  });

  it('⭐ 每张开了 RLS 的业务表都真的有 tenant_isolation 策略', async () => {
    const rows = await sql<{ relname: string }[]>`
      select c.relname from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attname = 'org_id' and a.attnum > 0
      where n.nspname = 'public' and c.relkind = 'r'
        and not exists (
          select 1 from pg_policy p
          where p.polrelid = c.oid and p.polname = 'tenant_isolation')
      order by c.relname`;
    // 开了 RLS 但没有策略 = 拒绝一切，比泄露安全但同样是 bug
    expect(rows.map((r) => r.relname)).toEqual([]);
  });
});

describe('宪法第 15 条：约束分层', () => {
  it('⭐ 技师并发【没有】数据库排他约束 —— 超卖靠应用层管', async () => {
    const [r] = await sql<{ n: number }[]>`
      select count(*)::int as n from pg_constraint
      where conrelid = 'appointment_items'::regclass
        and contype = 'x'
        and pg_get_constraintdef(oid) ilike '%membership_id%'`;
    expect(r?.n).toBe(0);
  });

  it('资源【有】排他约束 —— 房间物理上不可能同时两人', async () => {
    const [r] = await sql<{ n: number }[]>`
      select count(*)::int as n from pg_constraint
      where conrelid = 'appointment_items'::regclass
        and contype = 'x'
        and pg_get_constraintdef(oid) ilike '%resource_id%'`;
    expect(r?.n).toBe(1);
  });

  it('超卖放行必须带原因', async () => {
    const [r] = await sql<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint
      where conname = 'overbook_needs_reason'`;
    expect(r?.def).toMatch(/overbook_reason/);
  });
});

describe('宪法第 16 条：手机号不是唯一键', () => {
  it('同一手机号可以有多个客户（夫妻/母女共号）', async () => {
    const rows = await withTenant({ orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: null },
      (tx) => tx<{ display_name: string }[]>`
        select display_name from customers where phone_e164 = '+19175550188'`);
    expect(rows.length).toBe(2);
  });

  it('但同号 + 同名会被挡（真重复录入）', async () => {
    await expect(
      withTenant({ orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: null }, (tx) =>
        tx`insert into customers (org_id, display_name, phone_e164, source)
           values (${NAIL_ORG}, ${'张女士'}, '+19175550188', 'walkin')`),
    ).rejects.toThrow(/duplicate key|customers_no_exact_dup/i);
  });
});
