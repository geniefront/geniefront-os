/**
 * Phase 1c 验收：技师端这条链路。
 *
 * 覆盖的是「不这么做就会出事」的那几件：
 *   · 手机号在**服务端**脱敏（前端遮的东西 F12 一开就在那儿）
 *   · 开始/完成的幂等与补录（前台代点时天天发生）
 *   · 打卡顺序校验与重放（劳资纠纷里的证据）
 *   · 代打卡留下「谁替谁打的」
 *   · 技师看不到别人的今日单
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { withTenant, closeDb } from '@gf/db';
import { buildContext } from './actor';
import { dispatch } from './bus';
import { replayPunches } from './handlers/staff';
import { maskPhone, loadStaffToday, buildTask, type TaskRow } from './queries/staff';
import './handlers/ticket';
import './handlers/staff';

const NAIL_ORG = '11111111-1111-4111-8111-111111111111';
const NAIL_LOC = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const tenant = { orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: null };

let amy = '';    // 店长兼技师
let linh = '';   // 纯技师（没有 customer.view_contact）
let service = '';

async function ctxFor(membershipId: string) {
  const [r] = await withTenant(tenant, (tx) => tx<{ user_id: string }[]>`
    select user_id from memberships where id = ${membershipId}`);
  return buildContext({ userId: r!.user_id, membershipId });
}

const run = async <T>(name: string, input: unknown, ctx: Awaited<ReturnType<typeof ctxFor>>) =>
  (await dispatch<T>(name, input, ctx, { idempotencyKey: randomUUID() })).result;

/**
 * 今天的营业日。
 *
 * ⚠️ 必须减掉 business_day_cutoff：足疗店开到凌晨，01:30 那一单算「昨天」。
 * 直接用 `(now() at tz)::date` 的话，凌晨跑测试会拿到和 handler 不一样的日期，
 * 然后所有按日期查的断言都会莫名其妙地查到 0 行 —— 而白天跑又是好的。
 */
async function today(): Promise<string> {
  const [r] = await withTenant(tenant, (tx) => tx<{ d: string }[]>`
    select (((now() at time zone l.timezone) - l.business_day_cutoff)::date)::text as d
    from locations l where l.id = ${NAIL_LOC}`);
  return r!.d;
}


/** 把当天的单和打卡挪走，让每个用例从干净状态开始（财务表删不掉，见 money.test.ts） */
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
    // 日结封过账的话今天就写不了单了（assertDayOpen）。
    // 每行各挪一天，day_closes 有 (location, business_date) 唯一索引
    await tx`
      update day_closes d set business_date = (${park}::date + (x.rn)::int), status = 'open'
      from (select id, row_number() over (order by business_date) as rn
              from day_closes
             where location_id = ${NAIL_LOC} and business_date > '1999-01-01') x
      where d.id = x.id`;
    await tx`delete from command_idempotency where location_id = ${NAIL_LOC}`;
  });
}

beforeAll(async () => {
  const staff = await withTenant(tenant, (tx) => tx<{ membership_id: string; n: string }[]>`
    select membership_id, display_name->>'en' as n from staff_profiles
    where location_id = ${NAIL_LOC}`);
  amy = staff.find((s) => s.n === 'Amy')!.membership_id;
  linh = staff.find((s) => s.n === 'Linh')!.membership_id;

  const svcs = await withTenant(tenant, (tx) => tx<{ id: string }[]>`
    select id from services where location_id = ${NAIL_LOC} limit 1`);
  service = svcs[0]!.id;

  await reset();
});

afterAll(async () => { await closeDb(); });

// ────────────────────────────────────────────────────────── 脱敏

describe('⭐ 手机号脱敏（决策 16 防挖客）', () => {
  it('保留区号和尾号，中间打码', () => {
    expect(maskPhone('+19175551234')).toBe('917-***-1234');
    expect(maskPhone('9175551234')).toBe('917-***-1234');
  });

  it('号码太短或没有时不崩', () => {
    expect(maskPhone(null)).toBeNull();
    expect(maskPhone('123')).toBe('***');
  });

  it('⭐ 脱敏发生在服务端 —— 技师那份数据里根本没有完整号码', async () => {
    await reset();
    const amyCtx = await ctxFor(amy);
    const [cust] = await withTenant(tenant, (tx) => tx<{ id: string; phone: string }[]>`
      select id, phone_e164 as phone from customers
      where phone_e164 is not null order by display_name limit 1`);

    const t = await run<{ ticketId: string }>('ticket.open', {
      customerId: cust!.id,
      items: [{ serviceId: service, membershipId: linh, minutes: 45 }],
    }, amyCtx);
    expect(t.ticketId).toBeTruthy();

    const linhCtx = await ctxFor(linh);
    expect(linhCtx.permissions.has('customer.view_contact')).toBe(false);

    const date = await today();
    const snap = await withTenant(tenant, (tx) => loadStaffToday(tx, linhCtx, date, linh));
    const task = snap.tasks[0]!;
    expect(task.customerPhone).not.toBe(cust!.phone);
    expect(task.customerPhone).toMatch(/\*\*\*/);

    // 前台（有 view_contact）看到的是完整号
    const deskSnap = await withTenant(tenant, (tx) => loadStaffToday(tx, amyCtx, date, linh));
    expect(deskSnap.tasks[0]!.customerPhone).toBe(cust!.phone);
  });
});

// ────────────────────────────────────────────────────────── 开始 / 完成

describe('⭐ 技师在床边先看到哪一句', () => {
  /** 一行最小的任务数据。只填 buildTask 真正读的那几个字段 */
  const row = (over: Partial<TaskRow> = {}): TaskRow => ({
    ticket_id: 't', item_id: 'i',
    customer_name: '李丽', walk_in_name: null, phone: '+15125550142',
    customer_locale: null, service_name: '深层按摩 90 分钟', duration_min: 90,
    started_at: null, finished_at: null, resource_name: '3 号房',
    is_request: false, details: null, prefs: null, cust_notes: null, allergies: null,
    ticket_status: 'in_service', tip_settled_at: null, tip_cash: 0, tip_card: 0, direct_cash: 0,
    payout_settled: false,
    ...over,
  });

  it('健康表里有禁忌时，那一句排在最前面', () => {
    const t = buildTask(row({
      prefs: { health_flag: true, avoid_areas: ['lower_back'] },
    }), new Map(), true);
    // ⚠️ 顺序要紧：技师先看到的应该是「这位有事，去问一句」，
    // 而不是排在偏好后面的第四行
    expect(t.alerts[0]).toContain('禁忌');
    expect(t.alerts.some((a) => a.includes('长期避开'))).toBe(true);
  });

  it('⭐ 技师看得到「有禁忌」，但看不到任何明细', () => {
    const t = buildTask(row({
      prefs: { health_flag: true },
      // 就算有人往 profile 里塞了明细，技师这一层也不该把它读出来
      details: null,
    }), new Map(), true);
    const all = JSON.stringify(t);
    expect(all).toContain('禁忌');
    expect(all).not.toContain('怀孕');
    expect(all).not.toContain('血栓');
  });

  it('没有禁忌的客人不出这一句 —— 满屏警示等于没有警示', () => {
    const t = buildTask(row({ prefs: { health_flag: false } }), new Map(), true);
    expect(t.alerts.some((a) => a.includes('禁忌'))).toBe(false);
  });
});

describe('开始 / 完成', () => {
  it('开始 → 完成，算出实际工时，全部做完后单据转为待结账', async () => {
    await reset();
    const ctx = await ctxFor(amy);
    const t = await run<{ ticketId: string }>('ticket.open', {
      customerId: null, walkInName: '开始完成测试',
      items: [{ serviceId: service, membershipId: amy, minutes: 45 }],
    }, ctx);
    const [item] = await withTenant(tenant, (tx) => tx<{ id: string }[]>`
      select id from ticket_items where ticket_id = ${t.ticketId}`);

    await run('ticket.startItem', { ticketItemId: item!.id }, ctx);
    const fin = await run<{ actualMinutes: number; ticketDone: boolean }>(
      'ticket.finishItem', { ticketItemId: item!.id }, ctx);

    expect(fin.ticketDone).toBe(true);
    expect(fin.actualMinutes).toBeGreaterThanOrEqual(0);

    const [tk] = await withTenant(tenant, (tx) => tx<{ status: string }[]>`
      select status from tickets where id = ${t.ticketId}`);
    expect(tk!.status).toBe('ready_to_pay');
  });

  it('⭐ 重复点开始不会把开始时间往后推 —— 那会让工时凭空缩水', async () => {
    await reset();
    const ctx = await ctxFor(amy);
    const t = await run<{ ticketId: string }>('ticket.open', {
      customerId: null, walkInName: '重复开始',
      items: [{ serviceId: service, membershipId: amy, minutes: 45 }],
    }, ctx);
    const [item] = await withTenant(tenant, (tx) => tx<{ id: string }[]>`
      select id from ticket_items where ticket_id = ${t.ticketId}`);

    const a = await run<{ startedAt: string }>('ticket.startItem', { ticketItemId: item!.id }, ctx);
    await new Promise((r) => setTimeout(r, 50));
    const b = await run<{ startedAt: string }>('ticket.startItem', { ticketItemId: item!.id }, ctx);
    expect(b.startedAt).toBe(a.startedAt);
  });

  it('⭐ 没点开始直接点完成 → 按预估时长补一个开始时间，并在审计里标出来', async () => {
    await reset();
    const ctx = await ctxFor(amy);
    const t = await run<{ ticketId: string }>('ticket.open', {
      customerId: null, walkInName: '直接完成',
      items: [{ serviceId: service, membershipId: amy, minutes: 45 }],
    }, ctx);
    const [item] = await withTenant(tenant, (tx) => tx<{ id: string }[]>`
      select id from ticket_items where ticket_id = ${t.ticketId}`);

    const fin = await run<{ actualMinutes: number }>(
      'ticket.finishItem', { ticketItemId: item!.id }, ctx);
    // 补录的开始时间 = 现在 − 预估时长，所以实际分钟数约等于预估
    expect(fin.actualMinutes).toBeGreaterThanOrEqual(44);
    expect(fin.actualMinutes).toBeLessThanOrEqual(46);

    const [log] = await withTenant(tenant, (tx) => tx<{ after: Record<string, unknown> }[]>`
      select after from audit_log
      where command = 'ticket.finishItem' and entity_id = ${t.ticketId}
      order by at desc limit 1`);
    expect(log!.after['startBackfilled']).toBe(true);
  });

  it('结过账的单不能再点开始', async () => {
    await reset();
    const ctx = await ctxFor(amy);
    const t = await run<{ ticketId: string; subtotalCents: number }>('ticket.open', {
      customerId: null, walkInName: '已结账',
      items: [{ serviceId: service, membershipId: amy, minutes: 45 }],
    }, ctx);
    const [item] = await withTenant(tenant, (tx) => tx<{ id: string }[]>`
      select id from ticket_items where ticket_id = ${t.ticketId}`);
    await run('ticket.finishItem', { ticketItemId: item!.id }, ctx);
    await run('ticket.close', {
      ticketId: t.ticketId,
      payments: [{ method: 'cash', amountCents: t.subtotalCents, tipCents: 0 }],
    }, ctx);

    await expect(run('ticket.startItem', { ticketItemId: item!.id }, ctx))
      .rejects.toMatchObject({ code: 'TICKET_ALREADY_CLOSED' });
  });
});

describe('本人直收现金小费', () => {
  it('完成项目后可记录并更正，旧金额冲销且不进入待发现金', async () => {
    await reset();
    const ctx = await ctxFor(linh);
    const t = await run<{ ticketId: string }>('ticket.open', {
      customerId: null, walkInName: '现金直给',
      items: [{ serviceId: service, membershipId: linh, minutes: 45 }],
    }, ctx);
    const [item] = await withTenant(tenant, (tx) => tx<{ id: string }[]>`
      select id from ticket_items where ticket_id = ${t.ticketId}`);

    await expect(run('staff.recordDirectCashTip', {
      ticketItemId: item!.id, amountCents: 1200,
    }, ctx)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    await run('ticket.finishItem', { ticketItemId: item!.id }, ctx);
    await run('staff.recordDirectCashTip', { ticketItemId: item!.id, amountCents: 1200 }, ctx);
    await run('staff.recordDirectCashTip', { ticketItemId: item!.id, amountCents: 1500 }, ctx);

    const rows = await withTenant(tenant, (tx) => tx<{ amount_cents: number; reversed_at: string | null }[]>`
      select amount_cents, reversed_at::text as reversed_at from earnings
      where ticket_id = ${t.ticketId} and membership_id = ${linh}
        and basis->>'method' = 'direct_cash' order by created_at`);
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.reversed_at === null).map((row) => row.amount_cents)).toEqual([1500]);

    const date = await today();
    const snapshot = await withTenant(tenant, (tx) => loadStaffToday(tx, ctx, date, linh));
    expect(snapshot.earnings.tipCashCents).toBe(1500);
    expect(snapshot.earnings.cashTipOwedCents).toBe(0);
    expect(snapshot.tasks[0]?.tip).toMatchObject({
      directCashCents: 1500, status: 'received_direct', editable: true,
    });
  });
});

// ────────────────────────────────────────────────────────── 打卡

describe('打卡流水重放（纯函数）', () => {
  const at = (h: number, m = 0) => new Date(Date.UTC(2026, 7, 16, h, m));

  it('上班 → 下班：工时是两者之差', () => {
    const r = replayPunches([
      { kind: 'clock_in', at: at(10) }, { kind: 'clock_out', at: at(18) },
    ], at(20));
    expect(r.onDuty).toBe(false);
    expect(r.workedMinutes).toBe(480);
  });

  it('⭐ 休息不计薪：中间的休息段要扣掉', () => {
    const r = replayPunches([
      { kind: 'clock_in', at: at(10) },
      { kind: 'break_start', at: at(13) },
      { kind: 'break_end', at: at(13, 30) },
      { kind: 'clock_out', at: at(18) },
    ], at(20));
    expect(r.workedMinutes).toBe(450);
  });

  it('还没下班时算到此刻为止', () => {
    const r = replayPunches([{ kind: 'clock_in', at: at(10) }], at(12, 30));
    expect(r.onDuty).toBe(true);
    expect(r.workedMinutes).toBe(150);
  });

  it('休息中不累计工时', () => {
    const r = replayPunches([
      { kind: 'clock_in', at: at(10) }, { kind: 'break_start', at: at(11) },
    ], at(13));
    expect(r.workedMinutes).toBe(60);
  });

  it('乱序的流水按时间重排，结果一样', () => {
    const shuffled = replayPunches([
      { kind: 'clock_out', at: at(18) }, { kind: 'clock_in', at: at(10) },
    ], at(20));
    expect(shuffled.workedMinutes).toBe(480);
  });

  it('重复打上班卡不会重复计时', () => {
    const r = replayPunches([
      { kind: 'clock_in', at: at(10) }, { kind: 'clock_in', at: at(11) },
    ], at(12));
    expect(r.workedMinutes).toBe(120);
  });
});

describe('打卡命令', () => {
  it('上班 → 在岗；没上班不能下班', async () => {
    await reset();
    const ctx = await ctxFor(amy);
    const r = await run<{ onDuty: boolean }>('timeclock.punch', { kind: 'clock_in' }, ctx);
    expect(r.onDuty).toBe(true);

    await expect(run('timeclock.punch', { kind: 'clock_in' }, ctx))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    const out = await run<{ onDuty: boolean }>('timeclock.punch', { kind: 'clock_out' }, ctx);
    expect(out.onDuty).toBe(false);

    await expect(run('timeclock.punch', { kind: 'clock_out' }, ctx))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('⭐ 前台代打卡记下「谁替谁打的」', async () => {
    await reset();
    const deskCtx = await ctxFor(amy);   // Amy 是店长，有 punch_others
    await run('timeclock.punch', { kind: 'clock_in', membershipId: linh }, deskCtx);

    const [row] = await withTenant(tenant, (tx) => tx<{
      membership_id: string; on_behalf_by: string; method: string;
    }[]>`
      select membership_id, on_behalf_by, method from time_punches
      where location_id = ${NAIL_LOC} and membership_id = ${linh}
      order by at desc limit 1`);
    expect(row!.membership_id).toBe(linh);
    expect(row!.on_behalf_by).toBe(amy);
    expect(row!.method).toBe('desk');
  });

  it('⭐ 技师没有 punch_others，替不了别人打卡', async () => {
    await reset();
    const linhCtx = await ctxFor(linh);
    expect(linhCtx.permissions.has('timeclock.punch_others')).toBe(false);
    await expect(run('timeclock.punch', { kind: 'clock_in', membershipId: amy }, linhCtx))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('⭐ 打卡记录删不掉（劳资纠纷里的证据）', async () => {
    await expect(
      withTenant(tenant, (tx) => tx`delete from time_punches where location_id = ${NAIL_LOC}`),
    ).rejects.toThrow(/permission denied|不可删除/i);
  });
});

// ────────────────────────────────────────────────────────── 越权

describe('⭐ 技师只看得到自己的单', () => {
  it('loadStaffToday 只返回指定技师的行', async () => {
    await reset();
    const ctx = await ctxFor(amy);
    await run('ticket.open', {
      customerId: null, walkInName: '给 Amy 的',
      items: [{ serviceId: service, membershipId: amy, minutes: 45 }],
    }, ctx);
    await run('ticket.open', {
      customerId: null, walkInName: '给 Linh 的',
      items: [{ serviceId: service, membershipId: linh, minutes: 45 }],
    }, ctx);

    const date = await today();
    const linhCtx = await ctxFor(linh);
    const snap = await withTenant(tenant, (tx) => loadStaffToday(tx, linhCtx, date, linh));
    expect(snap.tasks).toHaveLength(1);
    expect(snap.tasks[0]!.customerName).toBe('给 Linh 的');
  });
});

describe('⭐ 多技师服务的服务端约束', () => {
  it('人数不足会拒绝，人数满足时持久化一主一辅两位技师', async () => {
    await reset();
    const ctx = await ctxFor(amy);
    await withTenant(tenant, (tx) => tx`
      update services set staff_count = 2 where id = ${service}
    `);

    try {
      await expect(run('ticket.open', {
        customerId: null,
        walkInName: '多人服务人数不足',
        items: [{
          serviceId: service,
          staffAssignments: [{ membershipId: amy, role: 'primary', minutes: 45 }],
          minutes: 45,
        }],
      }, ctx)).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
        details: expect.objectContaining({ reason: 'staff_count_mismatch' }),
      });

      const opened = await run<{ ticketId: string; ticketItemIds: string[] }>('ticket.open', {
        customerId: null,
        walkInName: '双人服务',
        items: [{
          serviceId: service,
          staffAssignments: [
            { membershipId: amy, role: 'primary', minutes: 45 },
            { membershipId: linh, role: 'assistant', minutes: 45 },
          ],
          minutes: 45,
        }],
      }, ctx);

      const assignments = await withTenant(tenant, (tx) => tx<{ membership_id: string; role: string }[]>`
        select membership_id, role
        from ticket_item_staff
        where ticket_item_id = ${opened.ticketItemIds[0]!}
        order by role desc, membership_id
      `);
      expect(assignments).toHaveLength(2);
      expect(assignments).toEqual(expect.arrayContaining([
        expect.objectContaining({ membership_id: amy, role: 'primary' }),
        expect.objectContaining({ membership_id: linh, role: 'assistant' }),
      ]));
    } finally {
      await withTenant(tenant, (tx) => tx`
        update services set staff_count = 1 where id = ${service}
      `);
    }
  });
});
