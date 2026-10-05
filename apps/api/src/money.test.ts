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
import { loadOrders } from './queries/orders';
import {loadDayMoney} from './handlers/dayclose';
import {loadDayClose} from './queries/money';
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

it('finds the displayed receipt number with consistent row and count filters', async () => {
  const ctx = await ctxFor(owner);
  const ticket = await openTicket(ctx, 'Displayed receipt lookup QA');
  const q = `ORD-${ticket.ticketId.slice(0, 5).toUpperCase()}`;
  const result = await withTenant(tenant, tx => loadOrders(tx, ctx, { q }));
  expect(result.rows.some(row => row.ticketId === ticket.ticketId)).toBe(true);
  expect(result.total).toBe(result.rows.length);
  const lower = await withTenant(tenant, tx => loadOrders(tx, ctx, { q: q.toLowerCase() }));
  expect(lower.rows.map(row => row.ticketId)).toEqual(result.rows.map(row => row.ticketId));
  const exact = await withTenant(tenant, tx => loadOrders(tx, ctx, { ticketId: ticket.ticketId, q }));
  expect(exact.total).toBe(1);
  expect(exact.rows[0]?.ticketId).toBe(ticket.ticketId);
});

async function ctxFor(membershipId: string) {
  const [r] = await withTenant(tenant, (tx) => tx<{ user_id: string }[]>`
    select user_id from memberships where id = ${membershipId}`);
  return buildContext({ userId: r!.user_id, membershipId });
}

const run = async <T>(name: string, input: unknown, ctx: Awaited<ReturnType<typeof ctxFor>>) =>
  (await dispatch<T>(name, input, ctx, { idempotencyKey: randomUUID() })).result;

/** 今天的营业日 —— 与 handler 用的是同一套算法，直接问库 */
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
    from locations l where l.id = ${SPA_LOC}`);
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
    // ⚠️ 停放时必须把断档补录那几列一起清掉（0032）。
    // 不清的话，一个 summary_only 的天被改回 status='open' 会撞
    // backfill_only_when_summary —— 那条约束防的正是「孤儿数字」：
    // 改了状态却留着补录金额，报表只看 status，永远发现不了它们还在。
    await tx`
      update day_closes d set business_date = (${parkDate}::date + (x.rn - 1)::int), status = 'open',
             backfill_gross_cents = null, backfill_cash_cents = null,
             backfill_card_cents = null, backfill_tip_cash_cents = null,
             backfill_tip_card_cents = null, gap_note = null
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

  /**
   * ⚠️ 这个用例必须用 `upfront_combined`，不能用默认的结账时机。
   *
   * 「作废一张已经落了钱的单」听起来像是「先结账、再作废」，但那条路
   * 现在是**明确关掉的** —— 已结账的单只能走 `ticket.refund`（见下一个
   * 用例）。于是问题变成：什么情况下一张单**还没结账**却已经有了
   * earnings 和小费分配？
   *
   * 答案是先收钱后做服务这两种时机：
   *   · `upfront_combined` 未完工 —— 钱和小费都收了，`closeNow` 是 false
   *   · `service_then_tip` 的 service 阶段 —— 提成落了，但小费必须为 0
   *
   * 前者是唯一能同时产生 earnings 与 tip_allocations 的可作废状态，
   * 也正是 `ticket.void` 里那段冲销代码真正要伺候的场景。
   * 用默认时机写这个用例，测到的是一条已经不存在的路。
   */
  it('⭐ 作废是冲销不是删除 —— 财务记录留着，但不再计入收入', async () => {
    await withTenant(tenant, (tx) => tx`
      insert into location_checkout_settings (location_id, checkout_timing)
      values (${SPA_LOC}, 'upfront_combined')
      on conflict (location_id) do update set checkout_timing = 'upfront_combined'`);
    try {
      const ctx = await ctxFor(owner);
      // 先收钱后做服务：收完这一笔，单子仍是 open —— 服务还没做完
      const t = await openTicket(ctx, '作废测试');
      await run('ticket.close', {
        ticketId: t.ticketId,
        payments: [{ method: 'cash', amountCents: t.subtotalCents + 500, tipCents: 500 }],
      }, ctx);

      const [before] = await withTenant(tenant, (tx) => tx<{ status: string }[]>`
        select status from tickets where id = ${t.ticketId}`);
      expect(before!.status).not.toBe('closed');   // 这个用例的前提

      await run('ticket.void', { ticketId: t.ticketId, reason: 'input_error' }, ctx);

      const rows = await withTenant(tenant, (tx) => tx<{ n: number; reversed: number }[]>`
        select count(*)::int as n,
               count(*) filter (where reversed_at is not null)::int as reversed
        from earnings where ticket_id = ${t.ticketId}`);
      expect(rows[0]!.n).toBeGreaterThan(0);       // 行还在
      expect(rows[0]!.reversed).toBe(rows[0]!.n);  // 但全都冲销了

      const tips = await withTenant(tenant, (tx) => tx<{ n: number; reversed: number }[]>`
        select count(*)::int as n,
               count(*) filter (where reversed_at is not null)::int as reversed
        from tip_allocations where ticket_id = ${t.ticketId}`);
      expect(tips[0]!.n).toBeGreaterThan(0);
      expect(tips[0]!.reversed).toBe(tips[0]!.n);
    } finally {
      // 结账时机是门店级设置，漏了这一步后面的用例会莫名其妙地走另一条路
      await withTenant(tenant, (tx) => tx`
        update location_checkout_settings
        set checkout_timing = 'after_service_combined' where location_id = ${SPA_LOC}`);
    }
  });

  /**
   * 已结账的单不许作废。
   *
   * 作废是「这一单不该存在」，退款是「这一单存在过，钱退回去」。
   * 钱已经收了之后只有后者说得通 —— 否则收款行、小费分配和日结现金
   * 会各自指向一张「从来没发生过」的单。
   */
  it('已结账的单不许作废 —— 要退款走 ticket.refund', async () => {
    const ctx = await ctxFor(owner);
    const t = await openTicket(ctx, '结账后作废');
    await run('ticket.close', {
      ticketId: t.ticketId,
      payments: [{ method: 'cash', amountCents: t.subtotalCents + 500, tipCents: 500 }],
    }, ctx);

    await expect(
      run('ticket.void', { ticketId: t.ticketId, reason: 'input_error' }, ctx),
    ).rejects.toMatchObject({ code: 'TICKET_ALREADY_CLOSED' });
  });

  it('结账税额按门店设置算，不信客户端 taxCents', async () => {
    await withTenant(tenant, (tx) => tx`
      update location_checkout_settings
      set sales_tax_rate_percent = 8.8750
      where location_id = ${SPA_LOC}`);
    try {
      const ctx = await ctxFor(owner);
      const t = await openTicket(ctx, '税额服务端');
      const expectedTax = Math.round(t.subtotalCents * 0.08875);

      await expect(run('ticket.close', {
        ticketId: t.ticketId,
        taxCents: 0,
        payments: [{ method: 'card', amountCents: t.subtotalCents, tipCents: 0 }],
      }, ctx)).rejects.toMatchObject({ code: 'PAYMENT_MISMATCH' });

      await run('ticket.close', {
        ticketId: t.ticketId,
        taxCents: 0,
        payments: [{ method: 'card', amountCents: t.subtotalCents + expectedTax, tipCents: 0 }],
      }, ctx);

      const [row] = await withTenant(tenant, (tx) => tx<{ tax: number }[]>`
        select tax_cents as tax from tickets where id = ${t.ticketId}`);
      expect(row!.tax).toBe(expectedTax);
    } finally {
      await withTenant(tenant, (tx) => tx`
        update location_checkout_settings
        set sales_tax_rate_percent = 0
        where location_id = ${SPA_LOC}`);
    }
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

  it('replays a group payment once and rejects a changed financial request with the same key',async()=>{
    const ctx=await ctxFor(owner),one=await openTicket(ctx,'Group retry one'),two=await openTicket(ctx,'Group retry two');
    const group=await run<{groupId:string}>('ticket.group',{ticketIds:[one.ticketId,two.ticketId]},ctx);
    const input={groupId:group.groupId,ticketIds:[one.ticketId,two.ticketId],payments:[{method:'cash',amountCents:one.subtotalCents+two.subtotalCents,tipCents:0}]},key=randomUUID();
    const first=await dispatch('ticket.closeGroup',input,ctx,{idempotencyKey:key}),replay=await dispatch('ticket.closeGroup',input,ctx,{idempotencyKey:key});
    expect(replay.replayed).toBe(true);expect(replay.result).toEqual(first.result);
    await expect(dispatch('ticket.closeGroup',{...input,payments:[{...input.payments[0]!,amountCents:input.payments[0]!.amountCents+100}]},ctx,{idempotencyKey:key})).rejects.toMatchObject({code:'IDEMPOTENCY_KEY_REUSED',details:{reason:'different_request'}});
    const [facts]=await withTenant(tenant,tx=>tx`select (select count(*)::int from payments where ticket_id=any(${input.ticketIds}::uuid[])) as payments,(select input_fingerprint is not null from command_idempotency where location_id=${SPA_LOC} and key=${key}) as fingerprint`);
    expect(facts).toMatchObject({payments:2,fingerprint:true});
  });

  it('keeps inclusive group tax inside each original price when splitting cash and card',async()=>{
    const ctx=await ctxFor(owner),[prior]=await withTenant(tenant,tx=>tx`select sales_tax_rate_percent,tax_calculation_mode from location_checkout_settings where location_id=${SPA_LOC}`);
    try{
      await withTenant(tenant,tx=>tx`update location_checkout_settings set sales_tax_rate_percent=6.5,tax_calculation_mode='inclusive' where location_id=${SPA_LOC}`);
      const one=await openTicket(ctx,'Inclusive group one'),two=await openTicket(ctx,'Inclusive group two'),ids=[one.ticketId,two.ticketId];
      const group=await run<{groupId:string}>('ticket.group',{ticketIds:ids,label:'Inclusive tax QA'},ctx),total=one.subtotalCents+two.subtotalCents+1001;
      const result=await run<{tickets:Array<{totalCents:number}>}>('ticket.closeGroup',{groupId:group.groupId,ticketIds:ids,payments:[{method:'cash',amountCents:Math.floor(total/2),tipCents:501},{method:'card',amountCents:total-Math.floor(total/2),tipCents:500}]},ctx);
      expect(result.tickets.reduce((n,t)=>n+t.totalCents,0)).toBe(total);
      const [facts]=await withTenant(tenant,tx=>tx`select sum(total_cents)::int as total,sum(tax_cents)::int as tax from tickets where id=any(${ids}::uuid[])`);expect(facts!.total).toBe(total);expect(facts!.tax).toBeGreaterThan(0);
    }finally{await withTenant(tenant,tx=>tx`update location_checkout_settings set sales_tax_rate_percent=${prior!.sales_tax_rate_percent},tax_calculation_mode=${prior!.tax_calculation_mode} where location_id=${SPA_LOC}`);}
  });

  it('quotes and settles grouped service and tip stages separately with one cash tender',async()=>{
    const ctx=await ctxFor(owner),one=await openTicket(ctx,'Stage group one'),two=await openTicket(ctx,'Stage group two'),ids=[one.ticketId,two.ticketId];
    await withTenant(tenant,tx=>tx`update tickets set checkout_timing_snapshot='service_then_tip' where id=any(${ids}::uuid[])`);
    const group=await run<{groupId:string}>('ticket.group',{ticketIds:ids},ctx),base=one.subtotalCents+two.subtotalCents;
    const serviceInput={groupId:group.groupId,ticketIds:ids,ticketSelections:ids.map(ticketId=>({ticketId,paymentStage:'service',tipCents:0})),payments:[{method:'cash',amountCents:base,tenderedCents:base+1000,changeCents:1000}]};
    const first=await run<{quoteHash:string;readyToPay:boolean}>('ticket.quoteGroup',serviceInput,ctx);expect(first.readyToPay).toBe(true);
    await run('ticket.closeGroup',{...serviceInput,expectedQuoteHash:first.quoteHash},ctx);
    const mid=await withTenant(tenant,tx=>tx`select service_settled_at,tip_settled_at from tickets where id=any(${ids}::uuid[])`);expect(mid.every(t=>t.service_settled_at&&!t.tip_settled_at)).toBe(true);
    const tipInput={groupId:group.groupId,ticketIds:ids,ticketSelections:ids.map(ticketId=>({ticketId,paymentStage:'tip',tipCents:500})),payments:[{method:'cash',amountCents:1000,tipCents:1000}]};
    await expect(run('ticket.quoteGroup',tipInput,ctx)).rejects.toMatchObject({details:{reason:'tip_stage_not_available'}});
    const items=await withTenant(tenant,tx=>tx<{id:string}[]>`select id from ticket_items where ticket_id=any(${ids}::uuid[])`);
    for(const item of items){await run('ticket.startItem',{ticketItemId:item.id,membershipId:tech[0]!},ctx);await run('ticket.finishItem',{ticketItemId:item.id,membershipId:tech[0]!},ctx);}
    const second=await run<{quoteHash:string;amountDueCents:number}>('ticket.quoteGroup',tipInput,ctx);expect(second.amountDueCents).toBe(1000);
    await run('ticket.closeGroup',{...tipInput,expectedQuoteHash:second.quoteHash},ctx);
    const [final]=await withTenant(tenant,tx=>tx`select sum(amount_cents)::int as amount,sum(tendered_cents)::int as tendered,sum(change_cents)::int as change from payments where ticket_id=any(${ids}::uuid[])`);
    expect(final).toMatchObject({amount:base+1000,tendered:base+1000,change:1000});
    const statuses=await withTenant(tenant,tx=>tx`select status from tickets where id=any(${ids}::uuid[])`);expect(statuses.every(t=>t.status==='closed')).toBe(true);
  });
  it('never creates a partial group when one requested ticket is missing',async()=>{
    const ctx=await ctxFor(owner),ticket=await openTicket(ctx,'Atomic group');
    await expect(run('ticket.group',{ticketIds:[ticket.ticketId,randomUUID()]},ctx)).rejects.toMatchObject({code:'VALIDATION_FAILED',details:{reason:'group_ticket_unavailable'}});
    const [row]=await withTenant(tenant,tx=>tx`select group_id from tickets where id=${ticket.ticketId}`);expect(row!.group_id).toBeNull();
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
    const finalized = await Promise.all([
      run('dayclose.finalize', { businessDate: d, force: true }, ctx),
      run('dayclose.finalize', { businessDate: d, force: true }, ctx),
    ]);
    expect(finalized[0]).toEqual(finalized[1]);
    const [closedHistory] = await withTenant(tenant, (tx) => tx<{ count: number; snapshot: unknown }[]>`
      select count(*)::int as count, max(snapshot::text)::jsonb as snapshot
      from day_close_events where day_close_id = (
        select id from day_closes where location_id = ${SPA_LOC} and business_date = ${d}
      )
        and event_type = 'closed'`);
    expect(closedHistory!.count).toBe(1);
    await expect(withTenant(tenant, (tx) => tx`
      update day_close_events set reason = 'tamper' where day_close_id = (
        select id from day_closes where location_id = ${SPA_LOC} and business_date = ${d}
      )`)).rejects.toBeTruthy();

    await expect(openTicket(ctx, '封账后开单'))
      .rejects.toMatchObject({ code: 'DAY_ALREADY_CLOSED' });

    // 封错了要能开回来，但必须给原因
    await run('dayclose.reopen', { businessDate: d, reason: '漏了一单现金' }, ctx);
    const [historyAfterReopen] = await withTenant(tenant, (tx) => tx<{ count: number }[]>`
      select count(*)::int as count from day_close_events
      where day_close_id = (
        select id from day_closes where location_id = ${SPA_LOC} and business_date = ${d}
      )`);
    expect(historyAfterReopen!.count).toBe(2);
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

it('returns a closed prior-day sale today while preserving its original close and tip earnings',async()=>{
 await resetMoney();const ctx=await ctxFor(owner),date=await today(),prior=new Date(Date.parse(date+'T00:00:00Z')-86400000).toISOString().slice(0,10);
 const ticket=await openTicket(ctx,'Cross-day original refund');
 await run('ticket.pay',{ticketId:ticket.ticketId,payments:[{method:'cash',amountCents:ticket.subtotalCents+1000,tipCents:1000}]},ctx);
 await withTenant(tenant,async tx=>{await tx`update tickets set business_date=${prior} where id=${ticket.ticketId}`;await tx`update earnings set business_date=${prior} where ticket_id=${ticket.ticketId}`;});
 const money=await withTenant(tenant,tx=>loadDayMoney(tx,SPA_LOC,prior));
 await run('dayclose.saveCount',{businessDate:prior,countedCashCents:money.cashTakeCents+money.movementsCents-money.tipPaidOutCents,openingFloatCents:0,closingFloatCents:0},ctx);
 await run('dayclose.finalize',{businessDate:prior,force:true},ctx);
 const original=await withTenant(tenant,tx=>loadDayClose(tx,ctx,prior)),beforeToday=await withTenant(tenant,tx=>loadDayMoney(tx,SPA_LOC,date));
 await expect(withTenant(tenant,tx=>tx`update tickets set refund_cents=1 where id=${ticket.ticketId}`)).rejects.toBeDefined();
 await expect(withTenant(tenant,tx=>tx`update tickets set subtotal_cents=subtotal_cents+1 where id=${ticket.ticketId}`)).rejects.toBeDefined();
 await run('ticket.refund',{ticketId:ticket.ticketId,refundAmountCents:ticket.subtotalCents+1000,refundTipCents:1000,reason:'other'},ctx);
 const after=await withTenant(tenant,tx=>loadDayClose(tx,ctx,prior)),todayMoney=await withTenant(tenant,tx=>loadDayMoney(tx,SPA_LOC,date));
 expect(after.money).toEqual(original.money);expect(after.latestMoney.tipCashCents).toBe(original.money.tipCashCents);
 expect(todayMoney.tipCashCents-beforeToday.tipCashCents).toBe(-1000);expect(todayMoney.movementsCents-beforeToday.movementsCents).toBe(-ticket.subtotalCents-1000);
 expect(todayMoney.netCents-beforeToday.netCents).toBe(-ticket.subtotalCents);
 await expect(withTenant(tenant,tx=>tx`update tickets set refund_cents=refund_cents-1 where id=${ticket.ticketId}`)).rejects.toBeDefined();
 await run('dayclose.reopen',{businessDate:prior,reason:'isolation fixture cleanup'},ctx);
});
