/**
 * 技师并发闸门（ticket.startItem）的验收。
 *
 * 这个文件存在的直接原因是一条线上故障：一位客人做多个项目、项目都派给
 * 同一位技师时，开单被判成 STAFF_OVER_CAPACITY。当时的计数按 ticket_item
 * 条数算，而 `max_concurrent_appointments` 的语义是**同时服务几位客人**。
 *
 * 每个用例对应门店里真实会发生的一种情形，不是为了凑覆盖率。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { withTenant, closeDb } from '@gf/db';
import { buildContext } from './actor';
import { dispatch } from './bus';
import './handlers/ticket';
import './handlers/staff';

const NAIL_ORG = '11111111-1111-4111-8111-111111111111';
const NAIL_LOC = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const tenant = { orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: null };

let amy = '';    // 店长兼技师（有 queue.manage，可代技师点开始）
let linh = '';   // 纯技师
let service = '';

async function ctxFor(membershipId: string) {
  const [r] = await withTenant(tenant, (tx) => tx<{ user_id: string }[]>`
    select user_id from memberships where id = ${membershipId}`);
  return buildContext({ userId: r!.user_id, membershipId });
}

const run = async <T>(name: string, input: unknown, ctx: Awaited<ReturnType<typeof ctxFor>>) =>
  (await dispatch<T>(name, input, ctx, { idempotencyKey: randomUUID() })).result;

/** 把当天的单挪走，让每个用例从干净状态开始（同 staff.test.ts 的做法） */
async function reset() {
  await withTenant(tenant, async (tx) => {
    const [mx] = await tx<{ d: string }[]>`
      select coalesce(max(business_date), '1980-01-01')::text as d from (
        select business_date from tickets where location_id = ${NAIL_LOC} and business_date < '1999-01-01'
        union all
        select business_date from day_closes where location_id = ${NAIL_LOC} and business_date < '1999-01-01'
      ) t`;
    const [y, m, d] = mx!.d.split('-').map(Number);
    const park = new Date(Date.UTC(y!, m! - 1, d! + 10)).toISOString().slice(0, 10);
    for (const t of ['tickets', 'earnings', 'time_punches'] as const) {
      await tx.unsafe(
        `update ${t} set business_date = $1 where location_id = $2 and business_date > '1999-01-01'`,
        [park, NAIL_LOC]);
    }
    await tx`
      update day_closes d set business_date = (${park}::date + (x.rn)::int), status = 'open'
      from (select id, row_number() over (order by business_date) as rn
              from day_closes
             where location_id = ${NAIL_LOC} and business_date > '1999-01-01') x
      where d.id = x.id`;
    await tx`delete from command_idempotency where location_id = ${NAIL_LOC}`;
  });
}

async function setMaxConcurrent(membershipId: string, n: number) {
  await withTenant(tenant, (tx) => tx`
    update staff_profiles set max_concurrent_appointments = ${n}
    where membership_id = ${membershipId}`);
}

async function setOverbookPolicy(policy: 'warn' | 'block') {
  await withTenant(tenant, (tx) => tx`
    update locations
       set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{capacity,overbook}', ${`"${policy}"`}::jsonb, true)
     where id = ${NAIL_LOC}`);
}

/** 开一张单，返回 ticketId 与各项目 id */
async function openTicket(
  ctx: Awaited<ReturnType<typeof ctxFor>>,
  staffIds: string[],
  walkInName: string,
) {
  return run<{ ticketId: string; ticketItemIds: string[] }>('ticket.open', {
    customerId: null,
    walkInName,
    items: staffIds.map((membershipId) => ({ serviceId: service, membershipId, minutes: 45 })),
  }, ctx);
}

beforeAll(async () => {
  const staff = await withTenant(tenant, (tx) => tx<{ membership_id: string; n: string }[]>`
    select membership_id, display_name->>'en' as n from staff_profiles
    where location_id = ${NAIL_LOC}`);
  amy = staff.find((s) => s.n === 'Amy')!.membership_id;
  linh = staff.find((s) => s.n === 'Linh')!.membership_id;

  const svcs = await withTenant(tenant, (tx) => tx<{ id: string }[]>`
    select id from services where location_id = ${NAIL_LOC} and active = true limit 1`);
  service = svcs[0]!.id;
});

afterAll(async () => {
  await setOverbookPolicy('warn');
  await setMaxConcurrent(linh, 2);
  await closeDb();
});

describe('技师并发按「客人」算，不按项目算', () => {
  it('⭐ 一位客人做两个项目、都派给同一位技师 → 两项都能开始（上限 1 也放行）', async () => {
    await reset();
    await setMaxConcurrent(linh, 1);
    const ctx = await ctxFor(amy);

    const t = await openTicket(ctx, [linh, linh], '做手又做脚');
    expect(t.ticketItemIds).toHaveLength(2);

    // 第一项开始 —— 这位客人占掉 Linh 唯一的那个位置
    await run('ticket.startItem', { ticketItemId: t.ticketItemIds[0], membershipId: linh }, ctx);
    // 第二项是**同一位客人**，不产生新的占位
    await expect(
      run('ticket.startItem', { ticketItemId: t.ticketItemIds[1], membershipId: linh }, ctx),
    ).resolves.toMatchObject({ ticketItemId: t.ticketItemIds[1] });
  });

  it('⭐ 加钟加项给同一位技师也不算新客人', async () => {
    await reset();
    await setMaxConcurrent(linh, 1);
    const ctx = await ctxFor(amy);

    const t = await openTicket(ctx, [linh], '加钟的客人');
    await run('ticket.startItem', { ticketItemId: t.ticketItemIds[0], membershipId: linh }, ctx);

    const added = await run<{ ticketItemId: string }>('ticket.addItem', {
      ticketId: t.ticketId, serviceId: service, membershipId: linh, kind: 'addon', minutes: 20,
    }, ctx);
    await expect(
      run('ticket.startItem', { ticketItemId: added.ticketItemId, membershipId: linh }, ctx),
    ).resolves.toBeTruthy();
  });

  it('换成两位不同的客人，同一位技师 → 拦住，并说清超到几位', async () => {
    await reset();
    await setMaxConcurrent(linh, 1);
    await setOverbookPolicy('warn');
    const ctx = await ctxFor(amy);

    const first = await openTicket(ctx, [linh], '客人甲');
    await run('ticket.startItem', { ticketItemId: first.ticketItemIds[0], membershipId: linh }, ctx);

    const second = await openTicket(ctx, [linh], '客人乙');
    await expect(
      run('ticket.startItem', { ticketItemId: second.ticketItemIds[0], membershipId: linh }, ctx),
    ).rejects.toMatchObject({
      code: 'STAFF_OVER_CAPACITY',
      overridable: true,
      details: expect.objectContaining({ membershipId: linh, limit: 1, wouldBe: 2 }),
    });
  });

  it('⭐ 上限 2 的美甲师：压到两位客人放行，第三位才拦', async () => {
    await reset();
    await setMaxConcurrent(linh, 2);
    const ctx = await ctxFor(amy);

    const a = await openTicket(ctx, [linh], '甲');
    const b = await openTicket(ctx, [linh], '乙');
    const c = await openTicket(ctx, [linh], '丙');
    await run('ticket.startItem', { ticketItemId: a.ticketItemIds[0], membershipId: linh }, ctx);
    await run('ticket.startItem', { ticketItemId: b.ticketItemIds[0], membershipId: linh }, ctx);
    await expect(
      run('ticket.startItem', { ticketItemId: c.ticketItemIds[0], membershipId: linh }, ctx),
    ).rejects.toMatchObject({ code: 'STAFF_OVER_CAPACITY' });
  });

  it('双技师服务里的副手也占一个位置', async () => {
    await reset();
    await setMaxConcurrent(linh, 1);
    const ctx = await ctxFor(amy);

    // 这项服务本来是一人做的，临时改成双人（洗头工 + 技师那种编制）
    await withTenant(tenant, (tx) => tx`
      update services set staff_count = 2 where id = ${service}`);
    try {
      const paired = await run<{ ticketId: string; ticketItemIds: string[] }>('ticket.open', {
        customerId: null, walkInName: '双人服务',
        items: [{
          serviceId: service, minutes: 45,
          staffAssignments: [
            { membershipId: amy, role: 'primary', minutes: 45 },
            { membershipId: linh, role: 'assistant', minutes: 45 },
          ],
        }],
      }, ctx);
      await run('ticket.startItem', { ticketItemId: paired.ticketItemIds[0], membershipId: amy }, ctx);

      // Linh 作为副手已经在这位客人身上了，再来一位就超了
      await withTenant(tenant, (tx) => tx`
        update services set staff_count = 1 where id = ${service}`);
      const solo = await openTicket(ctx, [linh], '下一位');
      await expect(
        run('ticket.startItem', { ticketItemId: solo.ticketItemIds[0], membershipId: linh }, ctx),
      ).rejects.toMatchObject({ code: 'STAFF_OVER_CAPACITY' });
    } finally {
      await withTenant(tenant, (tx) => tx`
        update services set staff_count = 1 where id = ${service}`);
    }
  });
});

describe('前台放行（override）', () => {
  it('⭐ 带 reason 重试即可放行 —— 客人就要这位技师、宁可等', async () => {
    await reset();
    await setMaxConcurrent(linh, 1);
    await setOverbookPolicy('warn');
    const ctx = await ctxFor(amy);

    const first = await openTicket(ctx, [linh], '客人甲');
    await run('ticket.startItem', { ticketItemId: first.ticketItemIds[0], membershipId: linh }, ctx);
    const second = await openTicket(ctx, [linh], '客人乙');

    await expect(run('ticket.startItem', {
      ticketItemId: second.ticketItemIds[0], membershipId: linh,
      override: { reason: 'guest_requested', note: '客人指定 Linh' },
    }, ctx)).resolves.toBeTruthy();

    // 放行要能事后复盘：审计能追责，列能聚合（sql/0108）
    const [item] = await withTenant(tenant, (tx) => tx<{
      overbooked: boolean; overbook_reason: string | null; overbook_note: string | null;
    }[]>`
      select overbooked, overbook_reason, overbook_note from ticket_items
      where id = ${second.ticketItemIds[0]!}`);
    expect(item).toMatchObject({
      overbooked: true, overbook_reason: 'guest_requested', overbook_note: '客人指定 Linh',
    });
  });

  it('正常开始的项目不带超排标记', async () => {
    await reset();
    await setMaxConcurrent(linh, 1);
    const ctx = await ctxFor(amy);

    const t = await openTicket(ctx, [linh], '正常的客人');
    await run('ticket.startItem', { ticketItemId: t.ticketItemIds[0], membershipId: linh }, ctx);
    const [item] = await withTenant(tenant, (tx) => tx<{
      overbooked: boolean; overbook_reason: string | null;
    }[]>`
      select overbooked, overbook_reason from ticket_items where id = ${t.ticketItemIds[0]!}`);
    expect(item).toMatchObject({ overbooked: false, overbook_reason: null });
  });

  it('放行后重复点「开始」不会把标记抹掉', async () => {
    await reset();
    await setMaxConcurrent(linh, 1);
    await setOverbookPolicy('warn');
    const ctx = await ctxFor(amy);

    const first = await openTicket(ctx, [linh], '客人甲');
    await run('ticket.startItem', { ticketItemId: first.ticketItemIds[0], membershipId: linh }, ctx);
    const second = await openTicket(ctx, [linh], '客人乙');
    await run('ticket.startItem', {
      ticketItemId: second.ticketItemIds[0], membershipId: linh,
      override: { reason: 'walk_in_stacking' },
    }, ctx);
    // 已经开始了，第二次点不会再走容量判断，也不该清掉上一次的放行记录
    await run('ticket.startItem', { ticketItemId: second.ticketItemIds[0], membershipId: linh }, ctx);

    const [item] = await withTenant(tenant, (tx) => tx<{
      overbooked: boolean; overbook_reason: string | null;
    }[]>`
      select overbooked, overbook_reason from ticket_items where id = ${second.ticketItemIds[0]!}`);
    expect(item).toMatchObject({ overbooked: true, overbook_reason: 'walk_in_stacking' });
  });

  it('门店设成 block 时不给放行入口，带 reason 也拦', async () => {
    await reset();
    await setMaxConcurrent(linh, 1);
    await setOverbookPolicy('block');
    const ctx = await ctxFor(amy);

    const first = await openTicket(ctx, [linh], '客人甲');
    await run('ticket.startItem', { ticketItemId: first.ticketItemIds[0], membershipId: linh }, ctx);
    const second = await openTicket(ctx, [linh], '客人乙');

    await expect(run('ticket.startItem', {
      ticketItemId: second.ticketItemIds[0], membershipId: linh,
      override: { reason: 'guest_requested' },
    }, ctx)).rejects.toMatchObject({
      code: 'STAFF_OVER_CAPACITY',
      overridable: false,
      details: expect.objectContaining({ overbookPolicy: 'block' }),
    });
    await setOverbookPolicy('warn');
  });
});

describe('活跃计数的边界', () => {
  it('⭐ 昨天忘点「完成」的单不能把今天锁死', async () => {
    await reset();
    await setMaxConcurrent(linh, 1);
    const ctx = await ctxFor(amy);

    const stale = await openTicket(ctx, [linh], '昨天的客人');
    await run('ticket.startItem', { ticketItemId: stale.ticketItemIds[0], membershipId: linh }, ctx);
    // 单还开着、项目也没点完成，只是营业日翻篇了
    await withTenant(tenant, (tx) => tx`
      update tickets set business_date = business_date - 1 where id = ${stale.ticketId}`);

    const today = await openTicket(ctx, [linh], '今天的客人');
    await expect(
      run('ticket.startItem', { ticketItemId: today.ticketItemIds[0], membershipId: linh }, ctx),
    ).resolves.toBeTruthy();
  });

  it('作废的单不再占位', async () => {
    await reset();
    await setMaxConcurrent(linh, 1);
    const ctx = await ctxFor(amy);

    const voided = await openTicket(ctx, [linh], '走单的客人');
    await run('ticket.startItem', { ticketItemId: voided.ticketItemIds[0], membershipId: linh }, ctx);
    await run('ticket.void', { ticketId: voided.ticketId, reason: 'walk_out' }, ctx);

    const next = await openTicket(ctx, [linh], '下一位');
    await expect(
      run('ticket.startItem', { ticketItemId: next.ticketItemIds[0], membershipId: linh }, ctx),
    ).resolves.toBeTruthy();
  });

  it('做完的单立刻把位置让出来', async () => {
    await reset();
    await setMaxConcurrent(linh, 1);
    const ctx = await ctxFor(amy);

    const done = await openTicket(ctx, [linh], '做完的客人');
    await run('ticket.startItem', { ticketItemId: done.ticketItemIds[0], membershipId: linh }, ctx);
    await run('ticket.finishItem', { ticketItemId: done.ticketItemIds[0], membershipId: linh }, ctx);

    const next = await openTicket(ctx, [linh], '下一位');
    await expect(
      run('ticket.startItem', { ticketItemId: next.ticketItemIds[0], membershipId: linh }, ctx),
    ).resolves.toBeTruthy();
  });

  it('重复点「开始」不因容量报错，也不改开始时刻', async () => {
    await reset();
    await setMaxConcurrent(linh, 1);
    const ctx = await ctxFor(amy);

    const t = await openTicket(ctx, [linh], '手滑点两下');
    const one = await run<{ startedAt: string }>(
      'ticket.startItem', { ticketItemId: t.ticketItemIds[0], membershipId: linh }, ctx);
    const two = await run<{ startedAt: string }>(
      'ticket.startItem', { ticketItemId: t.ticketItemIds[0], membershipId: linh }, ctx);
    expect(two.startedAt).toBe(one.startedAt);
  });

  it('开单本身不判并发 —— 前台可以先把等位客人的单开好', async () => {
    await reset();
    await setMaxConcurrent(linh, 1);
    const ctx = await ctxFor(amy);

    const busy = await openTicket(ctx, [linh], '正在做的客人');
    await run('ticket.startItem', { ticketItemId: busy.ticketItemIds[0], membershipId: linh }, ctx);

    // 开单不该报错：并发是从「开始」那一刻才成立的
    await expect(openTicket(ctx, [linh], '等位的客人')).resolves.toBeTruthy();
  });
});
