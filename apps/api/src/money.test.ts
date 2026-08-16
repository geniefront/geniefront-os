/**
 * Phase 1b 验收：钱这条链路端到端跑通。
 *
 * 覆盖的是「说不清就会吵架」的那几件事：
 *   · 结账落提成流水，作废时冲销而不是删除
 *   · 「不用找了」的找零变成小费，日结现金对得上
 *   · 组单一人付全部：每张单的账和每种支付方式的合计【同时】精确
 *   · 打烊点钞、现金进出、刷卡机对账、封账后不许再改
 *   · 现金小费发放的零头结转
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { withTenant, closeDb } from '@gf/db';
import { buildContext } from './actor';
import { dispatch } from './bus';
import './handlers/ticket';
import './handlers/dayclose';
import './handlers/payroll';

const SPA_ORG = '22222222-2222-4222-8222-222222222222';
const SPA_LOC = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

let owner = '';
let tech: string[] = [];
let service = '';
let servicePrice = 0;

const tenant = { orgId: SPA_ORG, locationId: SPA_LOC, membershipId: null };

async function ctxFor(membershipId: string) {
  const [r] = await withTenant(tenant, (tx) => tx<{ user_id: string }[]>`
    select user_id from memberships where id = ${membershipId}`);
  return buildContext({ userId: r!.user_id, membershipId });
}

const run = async <T>(name: string, input: unknown, ctx: Awaited<ReturnType<typeof ctxFor>>) =>
  (await dispatch<T>(name, input, ctx, { idempotencyKey: randomUUID() })).result;

/** 今天的营业日 —— 与 handler 用的是同一套算法，直接问库 */
async function today(): Promise<string> {
  const [r] = await withTenant(tenant, (tx) => tx<{ d: string }[]>`
    select (now() at time zone (select timezone from locations where id = ${SPA_LOC}))::date::text as d`);
  return r!.d;
}

/**
 * 把这家店「今天」的钱相关数据挪走，让每个用例从干净状态开始。
 *
 * 不能 delete：财务表对 app_user 是删不掉的（宪法第 9 条，0009 的触发器），
 * 而测试用的正是 app_user —— 换个角色跑就证明不了任何事。
 * 所以改成把它们迁到一个远古日期上。
 *
 * 每次用不同的远古日期，因为 day_closes / tip_payouts 有
 * (location, business_date) 唯一索引，堆在同一天会撞。
 */
async function resetMoney() {
  await withTenant(tenant, async (tx) => {
    // 停放日期要比【上一次跑测试】停过的都晚，否则跨次运行会撞唯一索引
    const [mx] = await tx<{ d: string }[]>`
      select greatest(
        coalesce((select max(business_date) from day_closes
                   where location_id = ${SPA_LOC} and business_date < '1999-01-01'), '1990-01-01'),
        coalesce((select max(business_date) from tip_payouts
                   where location_id = ${SPA_LOC} and business_date < '1999-01-01'), '1990-01-01')
      )::text as d`;
    const [y, m, d] = mx!.d.split('-').map(Number);
    const parkDate = new Date(Date.UTC(y!, m! - 1, d! + 1)).toISOString().slice(0, 10);

    for (const t of ['tickets', 'earnings', 'tip_payouts', 'cash_movements'] as const) {
      await tx.unsafe(
        `update ${t} set business_date = $1
         where location_id = $2 and business_date > '1999-01-01'`,
        [parkDate, SPA_LOC]);
    }
    // 可能有不止一行要挪（上一次跑到一半失败会留下）。
    // 唯一索引在 (location, business_date) 上，所以每行各给一天。
    await tx`
      update day_closes d set business_date = (${parkDate}::date + (x.rn - 1)::int), status = 'open'
      from (select id, row_number() over (order by business_date) as rn
              from day_closes
             where location_id = ${SPA_LOC} and business_date > '1999-01-01') x
      where d.id = x.id`;
    // 停放区必须是惰性的：留着 carry_out 的话，下一个用例会把它当成
    // 「昨天没发净的零头」加进今天的应发额（那正是这个字段该有的行为）
    await tx`update tip_payouts set carry_out_cents = 0, owed_cents = paid_cents
             where location_id = ${SPA_LOC} and business_date < '1999-01-01'`;
    await tx`delete from command_idempotency where location_id = ${SPA_LOC}`;
  });
}

beforeAll(async () => {
  const staff = await withTenant(tenant, (tx) => tx<{ membership_id: string; n: string }[]>`
    select membership_id, display_name->>'en' as n from staff_profiles
    where location_id = ${SPA_LOC} order by n`);
  owner = staff.find((s) => s.n === 'Owner')?.membership_id ?? staff[0]!.membership_id;
  tech = staff.filter((s) => s.n !== 'Owner').map((s) => s.membership_id);

  const svcs = await withTenant(tenant, (tx) => tx<{ id: string; p: number }[]>`
    select id, base_price_cents as p from services where location_id = ${SPA_LOC} order by p limit 1`);
  service = svcs[0]!.id;
  servicePrice = svcs[0]!.p;

  await resetMoney();

  // 一个明确的提成方案，否则测试会跟着默认值漂
  const ctx = await ctxFor(owner);
  await run('payroll.savePlan', {
    membershipId: null, kind: 'commission', rateBp: 4000,
    categoryRateBp: {}, retailRateBp: 1000, hourlyRateCents: 0, base: 'net',
  }, ctx);
});

afterAll(async () => { await closeDb(); });

async function openTicket(ctx: Awaited<ReturnType<typeof ctxFor>>, name: string, groupId?: string) {
  return run<{ ticketId: string; subtotalCents: number }>('ticket.open', {
    customerId: null, walkInName: name,
    ...(groupId ? { groupId } : {}),
    items: [{ serviceId: service, membershipId: tech[0]!, minutes: 60 }],
  }, ctx);
}

describe('结账落提成流水', () => {
  it('结完账就有 earnings，提成 = 净额 × 费率', async () => {
    const ctx = await ctxFor(owner);
    const t = await openTicket(ctx, '提成测试');

    await run('ticket.close', {
      ticketId: t.ticketId,
      payments: [{ method: 'card', amountCents: t.subtotalCents, tipCents: 0 }],
    }, ctx);

    const rows = await withTenant(tenant, (tx) => tx<{ kind: string; amount: number; base: number }[]>`
      select kind, amount_cents as amount, base_cents as base
      from earnings where ticket_id = ${t.ticketId}`);
    const commission = rows.find((r) => r.kind === 'commission')!;
    expect(commission.base).toBe(servicePrice);
    expect(commission.amount).toBe(Math.floor(servicePrice * 0.4));
  });

  it('小费也进 earnings，现金与刷卡分开记', async () => {
    const ctx = await ctxFor(owner);
    const t = await openTicket(ctx, '小费测试');
    await run('ticket.close', {
      ticketId: t.ticketId,
      payments: [{ method: 'cash', amountCents: t.subtotalCents + 1000, tipCents: 1000 }],
    }, ctx);

    const rows = await withTenant(tenant, (tx) => tx<{ kind: string; amount: number }[]>`
      select kind, amount_cents as amount from earnings where ticket_id = ${t.ticketId}`);
    expect(rows.find((r) => r.kind === 'tip_cash')?.amount).toBe(1000);
    expect(rows.find((r) => r.kind === 'tip_card')).toBeUndefined();
  });

  it('⭐ 作废是冲销不是删除 —— 财务记录留着，但不再计入收入', async () => {
    const ctx = await ctxFor(owner);
    const t = await openTicket(ctx, '作废测试');
    await run('ticket.close', {
      ticketId: t.ticketId,
      payments: [{ method: 'cash', amountCents: t.subtotalCents + 500, tipCents: 500 }],
    }, ctx);

    await run('ticket.void', { ticketId: t.ticketId, reason: 'input_error' }, ctx);

    const rows = await withTenant(tenant, (tx) => tx<{ n: number; reversed: number }[]>`
      select count(*)::int as n,
             count(*) filter (where reversed_at is not null)::int as reversed
      from earnings where ticket_id = ${t.ticketId}`);
    expect(rows[0]!.n).toBeGreaterThan(0);       // 行还在
    expect(rows[0]!.reversed).toBe(rows[0]!.n);  // 但全都冲销了

    const tips = await withTenant(tenant, (tx) => tx<{ reversed: number }[]>`
      select count(*) filter (where reversed_at is not null)::int as reversed
      from tip_allocations where ticket_id = ${t.ticketId}`);
    expect(tips[0]!.reversed).toBeGreaterThan(0);
  });

  it('收款额和单据对不上 → 当场拒绝', async () => {
    const ctx = await ctxFor(owner);
    const t = await openTicket(ctx, '金额不符');
    await expect(run('ticket.close', {
      ticketId: t.ticketId,
      payments: [{ method: 'cash', amountCents: t.subtotalCents - 100, tipCents: 0 }],
    }, ctx)).rejects.toMatchObject({ code: 'PAYMENT_MISMATCH' });
  });
});

describe('⭐ 现金「不用找了」', () => {
  it('找零转小费后，抽屉里应有的钱 = 客人给的钱', async () => {
    await resetMoney();
    const ctx = await ctxFor(owner);
    const t = await openTicket(ctx, '不用找了');

    // 客人给 100，服务 subtotal，说不用找了 → 差额全变小费
    const tendered = t.subtotalCents + 1500;
    await run('ticket.close', {
      ticketId: t.ticketId,
      payments: [{
        method: 'cash', amountCents: tendered, tipCents: 1500,
        tenderedCents: tendered, changeCents: 0, keepChange: true,
      }],
    }, ctx);

    const [p] = await withTenant(tenant, (tx) => tx<{
      amount: number; tip: number; tendered: number; change: number; keep: boolean;
    }[]>`
      select amount_cents as amount, tip_cents as tip, tendered_cents as tendered,
             change_cents as change, keep_change as keep
      from payments where ticket_id = ${t.ticketId}`);

    expect(p!.keep).toBe(true);
    expect(p!.change).toBe(0);
    // 这一条是整个特性的意义所在：进抽屉的钱 = 客人递过来的钱
    expect(p!.amount).toBe(p!.tendered);
    expect(p!.tip).toBe(1500);
  });

  it('正常找零时，进抽屉的是收款额而不是实收额', async () => {
    const ctx = await ctxFor(owner);
    const t = await openTicket(ctx, '正常找零');
    const total = t.subtotalCents;
    await run('ticket.close', {
      ticketId: t.ticketId,
      payments: [{
        method: 'cash', amountCents: total, tipCents: 0,
        tenderedCents: total + 2000, changeCents: 2000, keepChange: false,
      }],
    }, ctx);
    const [p] = await withTenant(tenant, (tx) => tx<{ amount: number; change: number }[]>`
      select amount_cents as amount, change_cents as change
      from payments where ticket_id = ${t.ticketId}`);
    expect(p!.amount).toBe(total);
    expect(p!.change).toBe(2000);
  });
});

describe('⭐ 组单：一人付全部', () => {
  it('每张单各记各的账，同时现金/刷卡合计分毫不差', async () => {
    await resetMoney();
    const ctx = await ctxFor(owner);

    const g = await run<{ groupId: string }>('ticket.group', {
      ticketIds: [], label: '三人行',
    }, ctx).catch(() => null);
    expect(g).toBeNull();   // 空数组会被 Zod 挡下

    const t1 = await openTicket(ctx, '甲');
    const t2 = await openTicket(ctx, '乙');
    const t3 = await openTicket(ctx, '丙');

    const grp = await run<{ groupId: string; ticketCount: number }>('ticket.group', {
      ticketIds: [t1.ticketId, t2.ticketId, t3.ticketId], label: '三人行',
    }, ctx);
    expect(grp.ticketCount).toBe(3);

    const subtotal = t1.subtotalCents + t2.subtotalCents + t3.subtotalCents;
    const tip = 2000;
    // 一半现金一半刷卡，故意让金额除不尽
    const cashAmount = 5000;
    const cardAmount = subtotal + tip - cashAmount;

    const out = await run<{ tickets: Array<{ ticketId: string; totalCents: number }> }>(
      'ticket.closeGroup', {
        groupId: grp.groupId,
        ticketIds: [t1.ticketId, t2.ticketId, t3.ticketId],
        payments: [
          { method: 'cash', amountCents: cashAmount, tipCents: 500 },
          { method: 'card', amountCents: cardAmount, tipCents: 1500 },
        ],
        payerTicketId: t1.ticketId,
      }, ctx);

    expect(out.tickets).toHaveLength(3);
    // 每张单的实收之和 = 整组收的钱
    expect(out.tickets.reduce((s, t) => s + t.totalCents, 0)).toBe(subtotal + tip);

    const [pays] = await withTenant(tenant, (tx) => tx<{ cash: number; card: number }[]>`
      select coalesce(sum(amount_cents) filter (where method = 'cash'), 0)::int as cash,
             coalesce(sum(amount_cents) filter (where method <> 'cash'), 0)::int as card
      from payments where ticket_id = any(${[t1.ticketId, t2.ticketId, t3.ticketId]})`);
    // ⭐ 这两条是整个拆分算法存在的理由：抽屉里的现金必须一分不差
    expect(pays!.cash).toBe(cashAmount);
    expect(pays!.card).toBe(cardAmount);

    // 每个人的提成照常各算各的
    const earn = await withTenant(tenant, (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from earnings
      where ticket_id = any(${[t1.ticketId, t2.ticketId, t3.ticketId]})
        and kind = 'commission'`);
    expect(earn[0]!.n).toBe(3);
  });

  it('不属于这一组的单不能混进来结', async () => {
    const ctx = await ctxFor(owner);
    const t1 = await openTicket(ctx, '组内');
    const outsider = await openTicket(ctx, '组外');
    const grp = await run<{ groupId: string }>('ticket.group', { ticketIds: [t1.ticketId] }, ctx);

    await expect(run('ticket.closeGroup', {
      groupId: grp.groupId,
      ticketIds: [t1.ticketId, outsider.ticketId],
      payments: [{ method: 'cash', amountCents: t1.subtotalCents + outsider.subtotalCents, tipCents: 0 }],
    }, ctx)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('⭐ 打烊日结', () => {
  it('点钞对上时差异为 0，现金进出计入期望值', async () => {
    await resetMoney();
    const ctx = await ctxFor(owner);
    const d = await today();

    const t = await openTicket(ctx, '日结测试');
    await run('ticket.close', {
      ticketId: t.ticketId,
      payments: [{ method: 'cash', amountCents: t.subtotalCents + 1000, tipCents: 1000 }],
    }, ctx);

    await run('dayclose.recordCash', {
      businessDate: d, kind: 'opening_float', amountCents: 20000, note: '早上备用金',
    }, ctx);
    await run('dayclose.recordCash', {
      businessDate: d, kind: 'supply_purchase', amountCents: -4500, note: '买棉片',
    }, ctx);

    const expected = 20000 + t.subtotalCents + 1000 - 4500;
    const r = await run<{
      expectedCashCents: number; cashVarianceCents: number; needsCashReason: boolean;
    }>('dayclose.saveCount', {
      businessDate: d,
      breakdown: {},
      countedCashCents: expected,
    }, ctx);

    expect(r.expectedCashCents).toBe(expected);
    expect(r.cashVarianceCents).toBe(0);
    expect(r.needsCashReason).toBe(false);
  });

  it('差异超阈值且没写原因 → 封账被拒', async () => {
    const ctx = await ctxFor(owner);
    const d = await today();
    await run('dayclose.saveCount', {
      businessDate: d, breakdown: {}, countedCashCents: 100,
    }, ctx);
    await expect(run('dayclose.finalize', { businessDate: d, force: true }, ctx))
      .rejects.toMatchObject({ code: 'VARIANCE_REASON_REQUIRED' });
  });

  it('⭐ 封账之后这一天的单改不动了', async () => {
    await resetMoney();
    const ctx = await ctxFor(owner);
    const d = await today();

    await run('dayclose.saveCount', { businessDate: d, breakdown: {}, countedCashCents: 0 }, ctx);
    await run('dayclose.finalize', { businessDate: d, force: true }, ctx);

    await expect(openTicket(ctx, '封账后开单'))
      .rejects.toMatchObject({ code: 'DAY_ALREADY_CLOSED' });

    // 封错了要能开回来，但必须给原因
    await run('dayclose.reopen', { businessDate: d, reason: '漏了一单现金' }, ctx);
    await expect(openTicket(ctx, '重开后开单')).resolves.toBeTruthy();
  });

  it('刷卡机数与系统数不一致时要求解释', async () => {
    await resetMoney();
    const ctx = await ctxFor(owner);
    const d = await today();
    const t = await openTicket(ctx, '刷卡对账');
    await run('ticket.close', {
      ticketId: t.ticketId,
      payments: [{ method: 'card', amountCents: t.subtotalCents, tipCents: 0 }],
    }, ctx);

    const r = await run<{ cardVarianceCents: number; needsCardReason: boolean }>(
      'dayclose.saveCount', {
        businessDate: d, breakdown: {}, countedCashCents: 0,
        cardTerminalCents: t.subtotalCents + 100,
      }, ctx);
    expect(r.cardVarianceCents).toBe(100);
    expect(r.needsCardReason).toBe(true);
  });
});

describe('⭐ 现金小费发放', () => {
  it('发到整元，零头结转到明天，并自动记一笔现金出账', async () => {
    await resetMoney();
    const ctx = await ctxFor(owner);
    const d = await today();

    const t = await openTicket(ctx, '小费发放');
    await run('ticket.close', {
      ticketId: t.ticketId,
      payments: [{ method: 'cash', amountCents: t.subtotalCents + 3760, tipCents: 3760 }],
    }, ctx);

    const r = await run<{
      totalPaidCents: number;
      payouts: Array<{ paidCents: number; carryOutCents: number; owedCents: number }>;
    }>('dayclose.payTips', { businessDate: d, roundToCents: 100 }, ctx);

    expect(r.payouts).toHaveLength(1);
    expect(r.payouts[0]!.owedCents).toBe(3760);
    expect(r.payouts[0]!.paidCents).toBe(3700);
    expect(r.payouts[0]!.carryOutCents).toBe(60);
    expect(r.totalPaidCents).toBe(3700);

    // 发出去的现金必须从抽屉里减掉，否则点钞会平白少这么多
    const [mv] = await withTenant(tenant, (tx) => tx<{ total: number }[]>`
      select coalesce(sum(amount_cents), 0)::int as total from cash_movements
      where location_id = ${SPA_LOC} and business_date = ${d} and kind = 'tip_payout'`);
    expect(mv!.total).toBe(-3700);
  });

  it('已经发过的部分不会重复发', async () => {
    const ctx = await ctxFor(owner);
    const d = await today();
    const again = await run<{ totalPaidCents: number }>(
      'dayclose.payTips', { businessDate: d, roundToCents: 100 }, ctx);
    // 今天该发的已经发完，只剩下 60 分的零头继续挂着
    expect(again.totalPaidCents).toBe(0);
  });
});
