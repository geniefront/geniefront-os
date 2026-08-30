/**
 * RLS 隔离测试 —— Phase 0 验收的核心。
 *
 * 这些测试用 app_user 连库（DATABASE_URL），不是 postgres。
 * 如果哪天有人把应用改成用 service_role 连库，这些测试会**全部通过但毫无意义** ——
 * 所以第一个测试就是断言「当前连接身份是 app_user」。
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { sql, withTenant, withUser, closeDb } from './client';
import { PLATFORM_OPS_USER_ID, PLATFORM_EXOPS_USER_ID } from './platform';

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

  /**
   * ⚠️ 这一条**不数条数**。
   *
   * 原先断言的是「nail 有 3 个客户、spa 有 1 个」—— 那是种子数据的形状，
   * 不是隔离性质。公开预约上线后官网每建一单就多一个客户，
   * 这条测试立刻红了，而 RLS 一点问题都没有：数字变了不等于隔离坏了。
   *
   * 现在断的是真正要保证的那件事：**看得见的每一行都属于当前租户，
   * 而对面那家的行一行都看不见。**
   */
  it('顾客数据不跨 org 泄露', async () => {
    const nail = await withTenant({ orgId: NAIL_ORG, locationId: null, membershipId: null },
      (tx) => tx<{ org_id: string }[]>`select org_id from customers`);
    const spa = await withTenant({ orgId: SPA_ORG, locationId: null, membershipId: null },
      (tx) => tx<{ org_id: string }[]>`select org_id from customers`);

    expect(nail.length).toBeGreaterThan(0);
    expect(spa.length).toBeGreaterThan(0);
    expect(nail.every((r) => r.org_id === NAIL_ORG)).toBe(true);
    expect(spa.every((r) => r.org_id === SPA_ORG)).toBe(true);

    // 反向再确认一次：拿着对面的 id 单点也查不到
    const spaIds = await withTenant({ orgId: SPA_ORG, locationId: null, membershipId: null },
      (tx) => tx<{ id: string }[]>`select id from customers limit 1`);
    const peek = await withTenant({ orgId: NAIL_ORG, locationId: null, membershipId: null },
      (tx) => tx`select id from customers where id = ${spaIds[0]!.id}`);
    expect(peek.length).toBe(0);
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

describe('隔离种子重置边界', () => {
  it('⭐ app_user 即使自行设置 app.seed_reset 也不能修改已日结财务数据', async () => {
    await expect(
      withTenant({ orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: null }, async (tx) => {
        await tx`select set_config('app.seed_reset', 'on', true)`;
        const [ticket] = await tx<{ id: string }[]>`
          select t.id
          from tickets t
          join day_closes d
            on d.location_id = t.location_id
           and d.business_date = t.business_date
           and d.status = 'closed'
          where t.location_id = ${NAIL_LOC}
          limit 1`;
        expect(ticket?.id).toBeTruthy();
        await tx`update tickets set status = status where id = ${ticket!.id}`;
      }),
    ).rejects.toThrow(/business day .* is closed/i);
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

  it('anon/authenticated/public 没有 public 业务表权限', async () => {
    const rows = await sql<{ grantee: string; table_name: string; privilege_type: string }[]>`
      select grantee, table_name, privilege_type
      from information_schema.role_table_grants
      where table_schema = 'public' and grantee in ('anon','authenticated','PUBLIC')
      order by grantee, table_name, privilege_type`;
    expect(rows).toEqual([]);
  });

  it('SECURITY DEFINER 函数都固定了 search_path', async () => {
    const rows = await sql<{ name: string }[]>`
      select p.proname as name from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prosecdef
        and not exists (
          select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) setting
          where setting like 'search_path=%'
        ) order by p.proname`;
    expect(rows).toEqual([]);
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

  it('资源仍是数据库硬约束 —— 只是从排他约束换成了容量触发器', async () => {
    // Phase 1b：一间房可以同时服务多人（足疗房排 6 张躺椅、双人房两张床），
    // 排他约束表达不了「最多 N 个」，所以换成计数触发器。
    // 约束**强度**没变：仍在数据库层，前台带 reason 也覆盖不了。
    const [x] = await sql<{ n: number }[]>`
      select count(*)::int as n from pg_constraint
      where conrelid = 'appointment_items'::regclass and contype = 'x'
        and pg_get_constraintdef(oid) ilike '%resource_id%'`;
    expect(x?.n).toBe(0);

    const [t] = await sql<{ n: number }[]>`
      select count(*)::int as n from pg_trigger
      where tgrelid = 'appointment_items'::regclass
        and tgname = 'resource_capacity_guard' and not tgisinternal`;
    expect(t?.n).toBe(1);
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

// ════════════════════════════════════════════════════════════════════════════
//  Phase 1b
// ════════════════════════════════════════════════════════════════════════════

const SPA_LOC = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

/** 在足疗店造一张预约，返回 appointment_items 的插入用参数 */
async function bookInRoom(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  args: { resourceId: string; membershipId: string; startHour: number; hours?: number },
) {
  const [appt] = await tx<{ id: string }[]>`
    insert into appointments (org_id, location_id, business_date, starts_at, ends_at)
    values (${SPA_ORG}, ${SPA_LOC}, '2026-09-01',
            ${`2026-09-01 ${String(args.startHour).padStart(2, '0')}:00:00+00`}::timestamptz,
            ${`2026-09-01 ${String(args.startHour + (args.hours ?? 1)).padStart(2, '0')}:00:00+00`}::timestamptz)
    returning id`;
  const [svc] = await tx<{ id: string }[]>`
    select id from services where location_id = ${SPA_LOC} limit 1`;
  return tx`
    insert into appointment_items
      (org_id, location_id, appointment_id, service_id, membership_id, resource_id,
       starts_at, ends_at, price_cents_snapshot, duration_min)
    values (${SPA_ORG}, ${SPA_LOC}, ${appt!.id}, ${svc!.id}, ${args.membershipId},
            ${args.resourceId},
            ${`2026-09-01 ${String(args.startHour).padStart(2, '0')}:00:00+00`}::timestamptz,
            ${`2026-09-01 ${String(args.startHour + (args.hours ?? 1)).padStart(2, '0')}:00:00+00`}::timestamptz,
            4000, 60)`;
}

describe('⭐ 房间多容量（一间房同时服务多人多技师）', () => {
  let roomId = '';
  let staff: string[] = [];

  beforeAll(async () => {
    await withTenant({ orgId: SPA_ORG, locationId: SPA_LOC, membershipId: null }, async (tx) => {
      const [r] = await tx<{ id: string }[]>`
        select id from resources where location_id = ${SPA_LOC} order by name limit 1`;
      roomId = r!.id;
      const rows = await tx<{ membership_id: string }[]>`
        select membership_id from staff_profiles where location_id = ${SPA_LOC} limit 3`;
      staff = rows.map((x) => x.membership_id);
    });
  });

  const clean = () => withTenant(
    { orgId: SPA_ORG, locationId: SPA_LOC, membershipId: null },
    (tx) => tx`delete from appointments where business_date = '2026-09-01'`);

  // 每个用例自己清一遍：容量测试之间互相污染的话，失败信息会指向错的那一条
  beforeEach(async () => { await clean(); });

  it('capacity = 1 时行为和从前一样：第二个人排不进去', async () => {
    await clean();
    await withTenant({ orgId: SPA_ORG, locationId: SPA_LOC, membershipId: null }, async (tx) => {
      await tx`update resources set capacity = 1, max_staff = null where id = ${roomId}`;
      await bookInRoom(tx, { resourceId: roomId, membershipId: staff[0]!, startHour: 10 });
    });
    await expect(
      withTenant({ orgId: SPA_ORG, locationId: SPA_LOC, membershipId: null }, (tx) =>
        bookInRoom(tx, { resourceId: roomId, membershipId: staff[1]!, startHour: 10 })),
    ).rejects.toThrow(/已经满了/);
    await clean();
  });

  it('⭐ capacity = 3 时同一时段能排三位客人三个技师', async () => {
    await clean();
    await withTenant({ orgId: SPA_ORG, locationId: SPA_LOC, membershipId: null }, async (tx) => {
      await tx`update resources set capacity = 3, max_staff = null where id = ${roomId}`;
      for (let i = 0; i < 3; i++) {
        await bookInRoom(tx, {
          resourceId: roomId, membershipId: staff[i % staff.length]!, startHour: 10,
        });
      }
      const [n] = await tx<{ n: number }[]>`
        select count(*)::int as n from appointment_items ai
        join appointments a on a.id = ai.appointment_id
        where ai.resource_id = ${roomId} and a.business_date = '2026-09-01'`;
      expect(n!.n).toBe(3);
    });
    // 第四个还是要被拦下 —— 容量是硬的，不是软告警
    await expect(
      withTenant({ orgId: SPA_ORG, locationId: SPA_LOC, membershipId: null }, (tx) =>
        bookInRoom(tx, { resourceId: roomId, membershipId: staff[0]!, startHour: 10 })),
    ).rejects.toThrow(/已经满了/);
    await clean();
  });

  it('错开时段不算占用', async () => {
    await clean();
    await withTenant({ orgId: SPA_ORG, locationId: SPA_LOC, membershipId: null }, async (tx) => {
      await tx`update resources set capacity = 1, max_staff = null where id = ${roomId}`;
      await bookInRoom(tx, { resourceId: roomId, membershipId: staff[0]!, startHour: 10 });
      await bookInRoom(tx, { resourceId: roomId, membershipId: staff[0]!, startHour: 11 });
      const [n] = await tx<{ n: number }[]>`
        select count(*)::int as n from appointment_items ai
        join appointments a on a.id = ai.appointment_id
        where ai.resource_id = ${roomId} and a.business_date = '2026-09-01'`;
      expect(n!.n).toBe(2);
    });
    await clean();
  });

  it('max_staff 能挡住「两个技师被排进同一间单人房」', async () => {
    await clean();
    await withTenant({ orgId: SPA_ORG, locationId: SPA_LOC, membershipId: null }, async (tx) => {
      await tx`update resources set capacity = 4, max_staff = 1 where id = ${roomId}`;
      await bookInRoom(tx, { resourceId: roomId, membershipId: staff[0]!, startHour: 10 });
      // 同一个技师再加一位客人：可以（一人带两个躺椅）
      await bookInRoom(tx, { resourceId: roomId, membershipId: staff[0]!, startHour: 10 });
    });
    await expect(
      withTenant({ orgId: SPA_ORG, locationId: SPA_LOC, membershipId: null }, (tx) =>
        bookInRoom(tx, { resourceId: roomId, membershipId: staff[1]!, startHour: 10 })),
    ).rejects.toThrow(/最多 1 位技师/);
    await clean();
    await withTenant({ orgId: SPA_ORG, locationId: SPA_LOC, membershipId: null },
      (tx) => tx`update resources set capacity = 1, max_staff = null where id = ${roomId}`);
  });
});

describe('⭐ 钱的守护约束（Phase 1b）', () => {
  it('「不用找了」时不能同时有找零 —— 否则日结现金一定对不上', async () => {
    const [t] = await withTenant(
      { orgId: SPA_ORG, locationId: SPA_LOC, membershipId: null },
      (tx) => tx<{ id: string }[]>`
        insert into tickets (org_id, location_id, business_date, status)
        values (${SPA_ORG}, ${SPA_LOC}, '2026-09-02', 'in_service') returning id`);

    await expect(
      withTenant({ orgId: SPA_ORG, locationId: SPA_LOC, membershipId: null }, (tx) =>
        tx`insert into payments
             (org_id, location_id, ticket_id, method, amount_cents, tip_cents,
              tendered_cents, change_cents, keep_change)
           values (${SPA_ORG}, ${SPA_LOC}, ${t!.id}, 'cash', 8500, 1500, 10000, 500, true)`),
    ).rejects.toThrow(/payment_change_consistent/);
  });

  it('客人给的钱不够付这一单也拦下', async () => {
    const [t] = await withTenant(
      { orgId: SPA_ORG, locationId: SPA_LOC, membershipId: null },
      (tx) => tx<{ id: string }[]>`
        insert into tickets (org_id, location_id, business_date, status)
        values (${SPA_ORG}, ${SPA_LOC}, '2026-09-02', 'in_service') returning id`);
    await expect(
      withTenant({ orgId: SPA_ORG, locationId: SPA_LOC, membershipId: null }, (tx) =>
        tx`insert into payments
             (org_id, location_id, ticket_id, method, amount_cents, tendered_cents, change_cents)
           values (${SPA_ORG}, ${SPA_LOC}, ${t!.id}, 'cash', 10000, 5000, 0)`),
    ).rejects.toThrow(/payment_change_consistent/);
  });

  it('小费发放的账必须自洽：应发 = 实发 + 结转', async () => {
    const [m] = await withTenant(
      { orgId: SPA_ORG, locationId: SPA_LOC, membershipId: null },
      (tx) => tx<{ membership_id: string }[]>`
        select membership_id from staff_profiles where location_id = ${SPA_LOC} limit 1`);
    await expect(
      withTenant({ orgId: SPA_ORG, locationId: SPA_LOC, membershipId: null }, (tx) =>
        tx`insert into tip_payouts
             (org_id, location_id, business_date, membership_id,
              owed_cents, paid_cents, carry_out_cents)
           values (${SPA_ORG}, ${SPA_LOC}, '2026-09-02', ${m!.membership_id}, 3760, 3700, 100)`),
    ).rejects.toThrow(/tip_payout_balances/);
  });

  it('⭐ app_user 删不掉财务流水（宪法第 9 条）', async () => {
    await expect(
      withTenant({ orgId: SPA_ORG, locationId: SPA_LOC, membershipId: null }, (tx) =>
        tx`delete from earnings where location_id = ${SPA_LOC}`),
    ).rejects.toThrow(/permission denied|不可删除/i);
  });

  it('提成方案不许存进离谱的费率 —— 只在 UI 挡不够', async () => {
    await expect(
      withTenant({ orgId: SPA_ORG, locationId: SPA_LOC, membershipId: null }, (tx) =>
        tx`insert into compensation_plans (org_id, location_id, version, config)
           values (${SPA_ORG}, ${SPA_LOC}, 1,
                   '{"kind":"commission","rateBp":20000}'::jsonb)`),
    ).rejects.toThrow(/comp_plan_sane/);
  });

  it('班次跨夜要用大于 1440 表达，结束早于开始直接拒绝', async () => {
    const [m] = await withTenant(
      { orgId: SPA_ORG, locationId: SPA_LOC, membershipId: null },
      (tx) => tx<{ membership_id: string }[]>`
        select membership_id from staff_profiles where location_id = ${SPA_LOC} limit 1`);
    await expect(
      withTenant({ orgId: SPA_ORG, locationId: SPA_LOC, membershipId: null }, (tx) =>
        tx`insert into shifts (org_id, location_id, membership_id, business_date,
                               start_min, end_min, break_min)
           values (${SPA_ORG}, ${SPA_LOC}, ${m!.membership_id}, '2026-09-02', 1080, 120, 0)`),
    ).rejects.toThrow(/shift_bounds_valid/);

    // 跨夜的正确写法能过
    await withTenant({ orgId: SPA_ORG, locationId: SPA_LOC, membershipId: null }, (tx) =>
      tx`insert into shifts (org_id, location_id, membership_id, business_date,
                             start_min, end_min, break_min)
         values (${SPA_ORG}, ${SPA_LOC}, ${m!.membership_id}, '2026-09-03', 1080, 1560, 0)
         on conflict do nothing`);
  });
});

describe('platform operator isolation (sql/0074)', () => {
  const OWNER_USER = '196f0ab4-cd94-45cc-8109-2c414e966828';

  it('FORCE RLS remains on platform tables', async () => {
    const rows = await sql<{ relname: string; forced: boolean }[]>`
      select c.relname, c.relforcerowsecurity as forced
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname in ('platform_operators', 'support_requests', 'support_request_notes')`;
    expect(rows.length).toBe(3);
    expect(rows.every((r) => r.forced)).toBe(true);
  });

  it('app_user still has no BYPASSRLS', async () => {
    const [r] = await sql<{ bypass: boolean }[]>`
      select rolbypassrls as bypass from pg_roles where rolname = current_user`;
    expect(r?.bypass).toBe(false);
  });

  it('store owner is not a platform operator', async () => {
    const [row] = await withUser(OWNER_USER, (tx) =>
      tx<{ role: string | null }[]>`select gf_platform_operator_role() as role`);
    expect(row?.role).toBeNull();
  });

  it('revoked operator is not a platform operator', async () => {
    const [row] = await withUser(PLATFORM_EXOPS_USER_ID, (tx) =>
      tx<{ role: string | null }[]>`select gf_platform_operator_role() as role`);
    expect(row?.role).toBeNull();
  });

  it('seeded operator role is super_admin', async () => {
    const [row] = await withUser(PLATFORM_OPS_USER_ID, (tx) =>
      tx<{ role: string | null }[]>`select gf_platform_operator_role() as role`);
    expect(row?.role).toBe('super_admin');
  });

  it('store owner cannot execute the cross-tenant store search', async () => {
    await expect(
      withUser(OWNER_USER, (tx) =>
        tx`select gf_platform_search_stores('', 10, 0)`),
    ).rejects.toThrow(/not_platform_operator|permission denied|42501/i);
  });

  it('authorized operator can see both seed stores through the platform function', async () => {
    const [row] = await withUser(PLATFORM_OPS_USER_ID, (tx) =>
      tx<{ data: { total: number; items: Array<{ orgId: string }> } }[]>`
        select gf_platform_search_stores('', 50, 0) as data`);
    expect(row!.data.total).toBeGreaterThanOrEqual(2);
    const orgs = new Set(row!.data.items.map((i) => i.orgId));
    expect(orgs.has(NAIL_ORG)).toBe(true);
    expect(orgs.has(SPA_ORG)).toBe(true);
  });

  it('ordinary tenant context cannot read platform_operators', async () => {
    const rows = await withTenant(
      { orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: null },
      (tx) => tx<{ n: number }[]>`select count(*)::int as n from platform_operators`);
    expect(rows[0]!.n).toBe(0);
  });

  it('app_user cannot insert platform_operators', async () => {
    await expect(
      withUser(OWNER_USER, (tx) => tx`
        insert into platform_operators (user_id, role)
        values (${OWNER_USER}, 'super_admin')`),
    ).rejects.toThrow();
  });
});
