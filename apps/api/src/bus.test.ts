/**
 * Phase 0 验收：
 *   跑通 appointment.create，产生审计记录，RLS 阻止跨 org 读取，多店切换正常。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql, withTenant, closeDb, listMembershipsForUser } from '@gf/db';
import { AppError } from '@gf/contracts';
import { dispatch } from './bus';
import { PUBLIC_SOURCES } from './handlers/appointment';
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
let gelRemoval: string;   // 15 分钟的加项，用来验加项计价
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
  gelRemoval = svcs.find((s) => s.n === 'Gel Removal')!.id;

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

  it('⭐ 一位客人多个项目、都点名同一位技师 → 放行（占的是同一个位置）', async () => {
    const ctx = await ctxFor(mia);
    // Linh 的 maxConcurrent 临时压到 1，确保「按项目算」会被判超
    await withTenant({ orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: null }, (tx) => tx`
      update staff_profiles set max_concurrent_appointments = 1 where membership_id = ${linh}`);
    try {
      const { result } = await create(ctx, {
        customerId: lisa,
        items: [
          { serviceId: gelService, membershipId: linh, startsAt: at(6) },
          // 刻意重叠：做手的时候脚在泡水，仍然是同一位客人
          { serviceId: gelService, membershipId: linh, startsAt: at(6, 15) },
        ],
      });
      expect(result.itemIds).toHaveLength(2);
      expect(result.overbookedItemIds).toEqual([]);
    } finally {
      await withTenant({ orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: null }, (tx) => tx`
        update staff_profiles set max_concurrent_appointments = 2 where membership_id = ${linh}`);
    }
  });

  it('⭐ partySize > 1（母女同来）时同一时刻同一技师仍然算超卖', async () => {
    const ctx = await ctxFor(mia);
    await withTenant({ orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: null }, (tx) => tx`
      update staff_profiles set max_concurrent_appointments = 1 where membership_id = ${linh}`);
    try {
      await expect(create(ctx, {
        customerId: lisa,
        partySize: 2,
        items: [
          { serviceId: gelService, membershipId: linh, startsAt: at(7) },
          { serviceId: gelService, membershipId: linh, startsAt: at(7, 15) },
        ],
      })).rejects.toMatchObject({ code: 'STAFF_OVER_CAPACITY' });
    } finally {
      await withTenant({ orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: null }, (tx) => tx`
        update staff_profiles set max_concurrent_appointments = 2 where membership_id = ${linh}`);
    }
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

describe('加项计价（addonIds）', () => {
  /**
   * ⭐ **加项是独立收费的服务，价格必须进 `price_cents_snapshot`。**
   *
   * 这条挡的是一个曾经真实存在、而且完全静默的漏收：`addonIds` 被原样存进
   * `addon_ids` 就不管了，`ticket.ts` 开工单时直接取 `price_cents_snapshot`，
   * 全链路没有任何一处回头读 `addon_ids` 补价 —— 于是「甲油胶 + 卸甲」这种单
   * 的加项钱一分都收不到，而账面上看不出任何异常。
   *
   * 公开预约那条路（`public/routes.ts` 的 `priceAndDuration`）本来就是累加的，
   * 所以三条建单路径的口径现在是一致的。
   */
  async function pricesOf(appointmentId: string) {
    return withTenant({ orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: null },
      (tx) => tx<{ price_cents_snapshot: number; duration_min: number; addon_ids: string[] }[]>`
        select price_cents_snapshot, duration_min, addon_ids
        from appointment_items where appointment_id = ${appointmentId}`);
  }

  async function basePriceOf(serviceId: string) {
    const [r] = await withTenant({ orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: null },
      (tx) => tx<{ p: number; d: number }[]>`
        select base_price_cents as p, duration_min as d from services where id = ${serviceId}`);
    return r!;
  }

  it('⭐ 加项的价格累加进快照，不再凭空消失', async () => {
    const ctx = await ctxFor(mia);
    const main = await basePriceOf(gelService);
    const addon = await basePriceOf(gelRemoval);

    const { result } = await create(ctx, {
      customerId: lisa,
      items: [{
        serviceId: gelService, membershipId: linh,
        startsAt: at(8), addonIds: [gelRemoval],
      }],
    });

    const [item] = await pricesOf(result.appointmentId);
    expect(item!.addon_ids).toContain(gelRemoval);
    expect(item!.price_cents_snapshot).toBe(main.p + addon.p);
  });

  it('没给 durationMin 时，时长也累加加项', async () => {
    const ctx = await ctxFor(mia);
    const main = await basePriceOf(gelService);
    const addon = await basePriceOf(gelRemoval);

    const { result } = await create(ctx, {
      customerId: lisa,
      items: [{ serviceId: gelService, membershipId: linh, startsAt: at(22), addonIds: [gelRemoval] }],
    });

    const [item] = await pricesOf(result.appointmentId);
    expect(item!.duration_min).toBe(main.d + addon.d);
  });

  it('⭐ 显式给了 durationMin 就以它为准 —— 截图导入常常已经写成了总时长', async () => {
    const ctx = await ctxFor(mia);
    const { result } = await create(ctx, {
      customerId: lisa,
      items: [{
        serviceId: gelService, membershipId: linh,
        startsAt: at(18), durationMin: 75, addonIds: [gelRemoval],
      }],
    });
    const [item] = await pricesOf(result.appointmentId);
    expect(item!.duration_min).toBe(75);
  });

  it('priceCentsOverride 仍然一票否决，加项不再另加', async () => {
    const ctx = await ctxFor(mia);
    const { result } = await create(ctx, {
      customerId: lisa,
      items: [{
        serviceId: gelService, membershipId: linh,
        startsAt: at(21), addonIds: [gelRemoval], priceCentsOverride: 3300,
      }],
    });
    const [item] = await pricesOf(result.appointmentId);
    expect(item!.price_cents_snapshot).toBe(3300);
  });

  it('⭐ 加项 id 查不到时直接拒，不静默存一个悬空引用', async () => {
    const ctx = await ctxFor(mia);
    await expect(create(ctx, {
      customerId: lisa,
      items: [{
        serviceId: gelService, membershipId: linh,
        startsAt: at(10), addonIds: [randomUUID()],
      }],
    })).rejects.toThrow(AppError);
  });
});

describe('确认信/短信只发给客人自己订的单', () => {
  /**
   * ⭐ **前台代订、到店散客、副驾录入 —— 一律不自动发。**
   *
   * 这些单里的手机号多半来自历史档案，客人从没勾过任何接收同意。往上面群发
   * 确认短信，轻则被投诉，重则整个发送域被运营商和邮件服务商标记成垃圾源 ——
   * 那会连带把官网自助和 AI 语音那两条**该发的**也一起送进垃圾箱。
   *
   * 只有 `web`（官网自助）和 `phone_ai`（AI 语音来电）放行：那两条路上客人是
   * 主动交出联系方式、并且知道自己刚订了一单的。
   */
  async function outboxCountsFor(appointmentId: string) {
    return withTenant({ orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: null }, async (tx) => {
      const [e] = await tx<{ n: number }[]>`
        select count(*)::int as n from email_outbox
        where entity_type = 'appointment' and entity_id = ${appointmentId}`;
      const [s] = await tx<{ n: number }[]>`
        select count(*)::int as n from sms_outbox
        where entity_type = 'appointment' and entity_id = ${appointmentId}`;
      return { emails: e!.n, sms: s!.n };
    });
  }

  // ⚠️ 一律不指定技师。这一组验的是「通知发不发」，和派给谁无关，
  // 而同文件里的容量用例会把 Linh 排满 —— 指定技师只会引入无关的失败。
  const book = async (source: string, hour: number) => {
    const ctx = await ctxFor(mia);
    const { result } = await create(ctx, {
      customerId: lisa,
      source,
      items: [{ serviceId: gelService, membershipId: null, startsAt: at(hour) }],
    });
    return outboxCountsFor(result.appointmentId);
  };

  it('⭐ 前台代订（desk）不发', async () => {
    expect(await book('desk', 2)).toEqual({ emails: 0, sms: 0 });
  });

  it('⭐ 副驾录入（ai_copilot）不发 —— 批量导入几十条更不能群发', async () => {
    expect(await book('ai_copilot', 3)).toEqual({ emails: 0, sms: 0 });
  });

  it('到店散客（walkin）不发', async () => {
    expect(await book('walkin', 4)).toEqual({ emails: 0, sms: 0 });
  });

  it('⭐ 改期不给非公开来路的客人发变更通知', async () => {
    const ctx = await ctxFor(mia);
    const { result } = await create(ctx, {
      customerId: lisa,
      source: 'desk',
      items: [{ serviceId: gelService, membershipId: null, startsAt: at(2, 30) }],
    });
    await dispatch('appointment.reschedule', {
      appointmentId: result.appointmentId, startsAt: at(2, 45),
    }, ctx, { idempotencyKey: randomUUID() });

    expect(await outboxCountsFor(result.appointmentId)).toEqual({ emails: 0, sms: 0 });
  });

  it('⭐ 取消也不发 —— 建单时没通知过，取消时更不该突然冒出来一条', async () => {
    const ctx = await ctxFor(mia);
    const { result } = await create(ctx, {
      customerId: lisa,
      source: 'ai_copilot',
      items: [{ serviceId: gelService, membershipId: null, startsAt: at(3, 30) }],
    });
    await dispatch('appointment.cancel', {
      appointmentId: result.appointmentId, reason: 'input_error', keepStaffTurn: false,
    }, ctx, { idempotencyKey: randomUUID() });

    expect(await outboxCountsFor(result.appointmentId)).toEqual({ emails: 0, sms: 0 });
  });

  it('⭐ 白名单里只有客人自己发起的那两条路', () => {
    // 正向（web 真的会入队一封确认信）由 `public.test.ts` 端到端覆盖 ——
    // 那里走的是完整的公开预约接口，客人的邮箱手机是请求里带进来的。
    // 这里锁的是**策略本身**：任何人往集合里加 'desk' / 'ai_copilot'，这条就红。
    expect([...PUBLIC_SOURCES].sort()).toEqual(['phone_ai', 'web']);
  });

});
