/**
 * Phase 0 验收：
 *   跑通 appointment.create，产生审计记录，RLS 阻止跨 org 读取，多店切换正常。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql, withTenant, closeDb, listMembershipsForUser } from '@gf/db';
import { AppError } from '@gf/contracts';
import { dispatch } from './bus';
import { buildContext } from './actor';

/** 测试里从 membership 反查 userId —— 生产环境这个值来自已验签的 JWT */
async function ctxFor(membershipId: string, extra: Record<string, unknown> = {}) {
  const [r] = await withTenant(
    { orgId: NAIL_ORG, locationId: null, membershipId: null },
    (tx) => tx<{ user_id: string }[]>`select user_id from memberships where id = ${membershipId}`);
  const [r2] = r ? [r] : await withTenant(
    { orgId: SPA_ORG, locationId: null, membershipId: null },
    (tx) => tx<{ user_id: string }[]>`select user_id from memberships where id = ${membershipId}`);
  return buildContext({ userId: r2!.user_id, membershipId, ...extra });
}
import './handlers/appointment';

const NAIL_LOC = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const SPA_LOC = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

let amy: string;    // 店长兼技师，maxConcurrent=2，不参与轮牌
let linh: string;   // 纯技师，maxConcurrent=2
let mia: string;    // 纯前台，is_bookable=false
let kim: string;    // 足疗店技师 Yan，maxConcurrent=1
let gelService: string;
let spaService: string;
let spaRoom: string;
let lisa: string;

/**
 * 这个文件专用的那一天。
 *
 * ⚠️ **不能用「明天」**。种子给两家店铺了几条演示预约，落点正是
 * 今天前后 —— 而下面 `beforeAll` 会把这一天清空。于是每跑一次测试，
 * 前端那边正在对着调的演示数据就消失一批，而他看到的现象是
 * 「刚才还有的单没了」，完全查不到原因（2026-08-26 真的发生过）。
 *
 * 挪到一个足够远、没有任何别的东西会用的日子，清理也只清这一天。
 * 远到 60 天以外还有一个好处：`min_minutes_ahead` 之类的近端护栏
 * 一条都碰不到。
 */
const TEST_DAY = '2027-03-15';   // 周一。固定日期，不随今天漂
const at = (h: number, m = 0) =>
  `${TEST_DAY}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`;

const NAIL_ORG = '11111111-1111-4111-8111-111111111111';
const SPA_ORG = '22222222-2222-4222-8222-222222222222';

beforeAll(async () => {
  /*
   * 测试要可重复：上一轮留下的预约会让容量判断的铺垫步骤直接超限。
   *
   * ⚠️ **只清 `TEST_DAY` 那一天**，不是整家店。
   * 这里以前是 `delete from appointments where location_id = ...`（不带日期），
   * 于是每跑一次测试就把种子的演示预约连锅端了 —— 前端在对着调的数据
   * 会莫名其妙消失，而那个现象和这个文件看不出任何关系。
   *
   * appointment_items 靠 FK 级联跟着走。
   */
  for (const [org, loc] of [[NAIL_ORG, NAIL_LOC], [SPA_ORG, SPA_LOC]] as const) {
    await withTenant({ orgId: org, locationId: loc, membershipId: null }, async (tx) => {
      await tx`delete from appointments
               where location_id = ${loc} and business_date = ${TEST_DAY}`;
      await tx`delete from command_idempotency where location_id = ${loc}`;
    });
  }

  const staff = await sql<{ membership_id: string; name: string; location_id: string }[]>`
    select membership_id, display_name->>'en' as name, location_id
    from staff_profiles`.catch(() => []);
  // staff_profiles 受 RLS 保护，用租户上下文读
  const nail = await withTenant({ orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: null },
    (tx) => tx<{ membership_id: string; name: string }[]>`
      select membership_id, display_name->>'en' as name from staff_profiles`);
  const spa = await withTenant({ orgId: SPA_ORG, locationId: SPA_LOC, membershipId: null },
    (tx) => tx<{ membership_id: string; name: string }[]>`
      select membership_id, display_name->>'en' as name from staff_profiles`);
  expect(staff).toEqual([]); // 没有上下文 → 读不到任何东西

  amy = nail.find((s) => s.name === 'Amy')!.membership_id;
  linh = nail.find((s) => s.name === 'Linh')!.membership_id;
  mia = nail.find((s) => s.name === 'Mia')!.membership_id;
  kim = spa.find((s) => s.name === 'Yan')!.membership_id;

  const svcs = await withTenant({ orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: null },
    (tx) => tx<{ id: string; n: string }[]>`select id, name->>'en' as n from services`);
  gelService = svcs.find((s) => s.n === 'Gel Manicure')!.id;

  const spaSvcs = await withTenant({ orgId: SPA_ORG, locationId: SPA_LOC, membershipId: null },
    (tx) => tx<{ id: string; n: string }[]>`select id, name->>'en' as n from services`);
  spaService = spaSvcs.find((s) => s.n === 'Foot Reflexology 60min')!.id;

  const rooms = await withTenant({ orgId: SPA_ORG, locationId: SPA_LOC, membershipId: null },
    (tx) => tx<{ id: string }[]>`select id from resources order by name limit 1`);
  spaRoom = rooms[0]!.id;

  const cust = await withTenant({ orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: null },
    (tx) => tx<{ id: string }[]>`select id from customers where display_name = 'Lisa Chen'`);
  lisa = cust[0]!.id;
});

afterAll(async () => {
  // 走的时候把 TEST_DAY 也带走 —— 留着的话它会出现在前端的月视图里，
  // 而那一格看起来和真数据没有区别
  for (const [org, loc] of [[NAIL_ORG, NAIL_LOC], [SPA_ORG, SPA_LOC]] as const) {
    await withTenant({ orgId: org, locationId: loc, membershipId: null }, (tx) => tx`
      delete from appointments where location_id = ${loc} and business_date = ${TEST_DAY}`);
  }
  await closeDb();
});

const create = (ctx: Awaited<ReturnType<typeof buildContext>>, input: unknown, key = randomUUID()) =>
  dispatch<{ appointmentId: string; itemIds: string[]; overbookedItemIds: string[]; businessDate: string }>(
    'appointment.create', input, ctx, { idempotencyKey: key });

describe('Phase 0 验收：appointment.create', () => {
  it('前台建一个预约 → 成功，返回营业日与 item', async () => {
    const ctx = await ctxFor(mia);
    const { result, replayed, undoToken } = await create(ctx, {
      customerId: lisa,
      items: [{ serviceId: gelService, membershipId: linh, startsAt: at(14) }],
    });
    expect(result.itemIds).toHaveLength(1);
    expect(result.overbookedItemIds).toEqual([]);
    expect(result.businessDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(replayed).toBe(false);
    // 命令声明了 reversible → 前端据此显示 60 秒撤销按钮
    expect(undoToken).toBeTruthy();
  });

  it('⭐ 产生了审计记录，且记的是操作人不是技师', async () => {
    const ctx = await ctxFor(mia);
    const { result } = await create(ctx, {
      customerId: lisa,
      items: [{ serviceId: gelService, membershipId: linh, startsAt: at(9) }],
    });
    const rows = await withTenant({ orgId: ctx.orgId, locationId: ctx.locationId, membershipId: null },
      (tx) => tx<{ command: string; actor_id: string; actor_kind: string; after: Record<string, unknown> }[]>`
        select command, actor_id, actor_kind, after from audit_log
        where entity_id = ${result.appointmentId}`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.command).toBe('appointment.create');
    expect(rows[0]!.actor_id).toBe(mia);       // 前台 Mia 建的
    expect(rows[0]!.actor_kind).toBe('user');
    expect(rows[0]!.after['itemCount']).toBe(1);
  });

  it('⭐ 幂等：同一个 key 重试不会重复建单', async () => {
    const ctx = await ctxFor(mia);
    const key = randomUUID();
    const first = await create(ctx, {
      customerId: lisa, items: [{ serviceId: gelService, membershipId: linh, startsAt: at(11) }],
    }, key);
    const second = await create(ctx, {
      customerId: lisa, items: [{ serviceId: gelService, membershipId: linh, startsAt: at(11) }],
    }, key);
    expect(second.replayed).toBe(true);
    expect(second.result.appointmentId).toBe(first.result.appointmentId);
  });

  it('缺 idempotencyKey → 拒绝（这个命令声明了 required）', async () => {
    const ctx = await ctxFor(mia);
    await expect(
      dispatch('appointment.create', {
        customerId: lisa, items: [{ serviceId: gelService, startsAt: at(12) }],
      }, ctx),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('权限（宪法第 6 条）', () => {
  it('⭐ 技师没有 appointment.write → 建单被拒', async () => {
    const ctx = await ctxFor(linh);
    expect(ctx.permissions.has('appointment.read')).toBe(true);
    expect(ctx.permissions.has('appointment.write')).toBe(false);
    await expect(
      create(ctx, { customerId: lisa, items: [{ serviceId: gelService, startsAt: at(13) }] }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('⭐ AI 的权限只能是操作人的子集，绝不提权', async () => {
    const full = await ctxFor(mia);
    const ai = await ctxFor(mia, { actorKind: 'ai', restrictTo: ['appointment.read'] });
    expect(full.permissions.has('appointment.write')).toBe(true);
    expect(ai.permissions.has('appointment.write')).toBe(false);
    await expect(
      create(ai, { customerId: lisa, items: [{ serviceId: gelService, startsAt: at(15) }] }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('一人多角色：Amy 同时是店长和技师，权限取并集', async () => {
    const ctx = await ctxFor(amy);
    expect(ctx.permissions.has('appointment.write')).toBe(true);  // manager
    expect(ctx.permissions.has('payroll.view_own')).toBe(true);   // tech
    expect(ctx.permissions.has('rotation.override')).toBe(true);  // manager
  });
});

describe('容量三层（01 §7.1）', () => {
  it('⭐ 技师超并发 → 软告警，不带 reason 时拒绝', async () => {
    const ctx = await ctxFor(mia);
    // Kim 在足疗店 maxConcurrent=1
    const spaCtx = await ctxFor(kim);
    void spaCtx;
    // 先占满 Linh（maxConcurrent=2）
    await create(ctx, { customerId: lisa, items: [{ serviceId: gelService, membershipId: linh, startsAt: at(16) }] });
    await create(ctx, { customerId: lisa, items: [{ serviceId: gelService, membershipId: linh, startsAt: at(16, 10) }] });
    await expect(
      create(ctx, { customerId: lisa, items: [{ serviceId: gelService, membershipId: linh, startsAt: at(16, 20) }] }),
    ).rejects.toMatchObject({ code: 'STAFF_OVER_CAPACITY' });
  });

  it('⭐ 带上 override reason → 放行，并标记 overbooked + 记原因', async () => {
    const ctx = await ctxFor(mia);
    const { result } = await create(ctx, {
      customerId: lisa,
      items: [{ serviceId: gelService, membershipId: linh, startsAt: at(16, 30) }],
      override: { reason: 'walk_in_stacking', note: '客人在泡脚等' },
    });
    expect(result.overbookedItemIds).toHaveLength(1);
    const rows = await withTenant({ orgId: ctx.orgId, locationId: ctx.locationId, membershipId: null },
      (tx) => tx<{ overbooked: boolean; overbook_reason: string; overbook_note: string }[]>`
        select overbooked, overbook_reason, overbook_note from appointment_items
        where id = ${result.overbookedItemIds[0]!}`);
    expect(rows[0]).toMatchObject({
      overbooked: true, overbook_reason: 'walk_in_stacking', overbook_note: '客人在泡脚等',
    });
  });

  it('⭐ 纯前台（is_bookable=false）不能被排单，带 reason 也不行', async () => {
    const ctx = await ctxFor(mia);
    await expect(
      create(ctx, {
        customerId: lisa,
        items: [{ serviceId: gelService, membershipId: mia, startsAt: at(17) }],
        override: { reason: 'desk_coordination' },
      }),
    ).rejects.toMatchObject({ code: 'STAFF_NOT_BOOKABLE' });
  });

  it('⭐ 资源硬冲突（同一房间同一时段）→ 拒绝，且不是数据库原始报错', async () => {
    const ownerRow = await withTenant(
      { orgId: SPA_ORG, locationId: SPA_LOC, membershipId: null },
      (tx) => tx<{ membership_id: string }[]>`
        select membership_id from staff_profiles where display_name->>'en' = 'Owner'`);
    const ctx = await ctxFor(ownerRow[0]!.membership_id);

    await create(ctx, { customerId: null, walkInName: '客人A',
      items: [{ serviceId: spaService, membershipId: kim, resourceId: spaRoom, startsAt: at(19) }] });

    const err = await create(ctx, { customerId: null, walkInName: '客人B',
      items: [{ serviceId: spaService, membershipId: null, resourceId: spaRoom, startsAt: at(19, 30) }],
      override: { reason: 'desk_coordination' },
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('RESOURCE_CONFLICT');
    // 前台看不懂 23P01，所以报错里必须是结构化的房间与时段
    expect((err as AppError).details['resourceId']).toBe(spaRoom);
    expect((err as AppError).overridable).toBe(false);
  });
});

describe('多店切换与租户隔离', () => {
  it('⭐ 同一个 user 在多家店有身份时，选店器列出全部', async () => {
    const [u] = await withTenant(
      { orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: null },
      (tx) => tx<{ user_id: string }[]>`
        select user_id from memberships where id = ${linh}`);
    const list = await listMembershipsForUser(u!.user_id);
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(list.every((m) => m.membershipId && m.locationId)).toBe(true);
  });

  it('⭐ 拿美甲店的上下文碰足疗店的项目 → 查不到，建单失败', async () => {
    const ctx = await ctxFor(mia); // 美甲店前台
    await expect(
      create(ctx, { customerId: null, walkInName: 'x',
        items: [{ serviceId: spaService, startsAt: at(20) }] }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('⭐ 两家店的预约互不可见', async () => {
    const nailCtx = await ctxFor(mia);
    const seen = await withTenant(
      { orgId: nailCtx.orgId, locationId: nailCtx.locationId, membershipId: null },
      (tx) => tx<{ n: number }[]>`
        select count(*)::int as n from appointments where location_id = ${SPA_LOC}`);
    expect(seen[0]!.n).toBe(0);
  });
});
