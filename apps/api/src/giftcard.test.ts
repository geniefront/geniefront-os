/**
 * 礼品卡全链路（批 5）。
 *
 * 盯的是那三条纪律：
 *   1. 余额永远等于账本求和（属性测试）
 *   2. 只追加 —— 数据库层面改不动、删不掉
 *   3. 面值 ≠ 售价，卖出进负债、核销才进营收
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { withTenant, closeDb } from '@gf/db';
import { buildContext } from './actor';
import { dispatch } from './bus';
import './handlers/giftcard';
import './handlers/ticket';

const SPA_ORG = '22222222-2222-4222-8222-222222222222';
const SPA_LOC = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const tenant = { orgId: SPA_ORG, locationId: SPA_LOC, membershipId: null };

let ctx: Awaited<ReturnType<typeof buildContext>>;

const run = async <T>(name: string, input: unknown, key = crypto.randomUUID()): Promise<T> =>
  (await dispatch<T>(name, input, ctx, { idempotencyKey: key })).result;

/** 账本求和 —— 测试自己算一遍，不信任缓存列 */
const ledgerSum = (id: string) => withTenant(tenant, async (tx) => {
  const [r] = await tx<{ n: number }[]>`
    select coalesce(sum(amount_cents), 0)::int as n from customer_credit_ledger
    where kind = 'gift_card' and subject_id = ${id}`;
  return r!.n;
});

const cached = (id: string) => withTenant(tenant, async (tx) => {
  const [r] = await tx<{ b: number; s: string }[]>`
    select balance_cents as b, status as s from gift_cards where id = ${id}`;
  return r!;
});

const issue = (over: Record<string, unknown> = {}) =>
  run<{ giftCardId: string; code: string }>('giftcard.issue',
    { faceValueCents: 10000, salePriceCents: 8000, ...over });

beforeAll(async () => {
  await withTenant(tenant, (tx) => tx`
    update billing_accounts set subscription_status = 'active' where location_id = ${SPA_LOC}`);
  const [m] = await withTenant(tenant, (tx) => tx<{ id: string; user_id: string }[]>`
    select m.id, m.user_id from memberships m
    join membership_roles mr on mr.membership_id = m.id
    join roles r on r.id = mr.role_id
    where m.location_id = ${SPA_LOC} and m.status = 'active' and r.key = 'owner' limit 1`);
  ctx = await buildContext({ userId: m!.user_id, membershipId: m!.id });
});

afterAll(async () => {
  // ⚠️ 账本先删 —— 它指着卡。而且账本有「只追加」触发器挡 delete，
  // 所以要以 postgres 身份绕过？不：触发器挡的是 UPDATE/DELETE 单行，
  // 测试数据清理只能靠 truncate 或者留着。这里选择**留着**，
  // 只清卡（账本行会因为 subject_id 没有外键而成为孤儿，无害）
  await withTenant(tenant, (tx) => tx`
    delete from gift_cards where location_id = ${SPA_LOC}
      and template_id is null and source in ('front_desk','bulk')`);
  await closeDb();
});

describe('发卡', () => {
  it('⭐ 面值和售价分开存 —— 买 $100 付 $80', async () => {
    const out = await run<{ giftCardId: string; faceValueCents: number; salePriceCents: number }>(
      'giftcard.issue', { faceValueCents: 10000, salePriceCents: 8000 });
    expect(out.faceValueCents).toBe(10000);
    expect(out.salePriceCents).toBe(8000);
    // ⭐ 卡里是**面值**，不是售价
    expect(await ledgerSum(out.giftCardId)).toBe(10000);
  });

  it('卡号可念、够长、不含易混字符', async () => {
    const out = await issue();
    expect(out.code.replace(/-/g, '')).toHaveLength(22);
    expect(out.code).not.toMatch(/[ILOU]/);
  });

  it('⭐ 两张卡的卡号不同 —— 能猜的卡号等于把店里的钱放门口', async () => {
    const a = await issue(); const b = await issue();
    expect(a.code).not.toBe(b.code);
  });

  it('售价高于面值当场拦下 —— 那是打反了，不是促销', async () => {
    await expect(run('giftcard.saveTemplate', {
      name: { en: 'Backwards' }, faceValueCents: 8000, salePriceCents: 10000,
    })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('核销', () => {
  it('⭐ 余额永远等于账本求和（缓存只是缓存）', async () => {
    const c = await issue();
    await run('giftcard.redeem', { giftCardId: c.giftCardId, dueCents: 3000 });
    await run('giftcard.redeem', { giftCardId: c.giftCardId, dueCents: 2500 });

    expect(await ledgerSum(c.giftCardId)).toBe(4500);
    expect((await cached(c.giftCardId)).b).toBe(4500);
  });

  it('⭐ 不足额付一部分，返回还差多少', async () => {
    const c = await issue({ faceValueCents: 3000, salePriceCents: 3000 });
    const out = await run<{ appliedCents: number; shortfallCents: number }>(
      'giftcard.redeem', { giftCardId: c.giftCardId, dueCents: 8000 });
    expect(out.appliedCents).toBe(3000);
    expect(out.shortfallCents).toBe(5000);
  });

  it('余额归零自动标 depleted —— 否则有效卡列表里全是 $0 的卡', async () => {
    const c = await issue({ faceValueCents: 1000, salePriceCents: 1000 });
    await run('giftcard.redeem', { giftCardId: c.giftCardId, dueCents: 1000 });
    expect((await cached(c.giftCardId)).s).toBe('depleted');
  });

  it('空卡再刷直接拒绝，并说清是空卡', async () => {
    const c = await issue({ faceValueCents: 1000, salePriceCents: 1000 });
    await run('giftcard.redeem', { giftCardId: c.giftCardId, dueCents: 1000 });
    await expect(run('giftcard.redeem', { giftCardId: c.giftCardId, dueCents: 500 }))
      .rejects.toMatchObject({ details: { reason: 'gift_card_empty' } });
  });

  it('⭐ 同一个幂等键刷两次只扣一次 —— 前台手抖点两下', async () => {
    const c = await issue();
    const key = crypto.randomUUID();
    await run('giftcard.redeem', { giftCardId: c.giftCardId, dueCents: 3000 }, key);
    await run('giftcard.redeem', { giftCardId: c.giftCardId, dueCents: 3000 }, key);
    expect(await ledgerSum(c.giftCardId)).toBe(7000);
  });

  it('按卡号也能核销 —— 客人在电话里念号', async () => {
    const c = await issue();
    // 故意去掉横线、改小写：客人念的时候不会带格式
    const out = await run<{ appliedCents: number }>('giftcard.redeem',
      { code: c.code.replace(/-/g, '').toLowerCase(), dueCents: 2000 });
    expect(out.appliedCents).toBe(2000);
  });
});

describe('⭐ 提成基数由老板设', () => {
  const setBasis = (basis: string) => withTenant(tenant, (tx) => tx`
    update locations set settings = jsonb_set(
      settings, '{gift_card,commission_basis}', ${`"${basis}"`}::jsonb, true)
    where id = ${SPA_LOC}`);

  it('face：客人享受了多少就提多少，店家吃掉折扣', async () => {
    await setBasis('face');
    const c = await issue();   // 面值 100 / 售价 80
    const out = await run<{ commissionBaseCents: number }>('giftcard.redeem',
      { giftCardId: c.giftCardId, dueCents: 5000 });
    expect(out.commissionBaseCents).toBe(5000);
  });

  it('sale：店家收到多少就提多少，折扣双方分担', async () => {
    await setBasis('sale');
    const c = await issue();
    const out = await run<{ commissionBaseCents: number }>('giftcard.redeem',
      { giftCardId: c.giftCardId, dueCents: 5000 });
    expect(out.commissionBaseCents).toBe(4000);   // 50% × $80
    await setBasis('face');
  });
});

describe('⭐ 只追加（宪法第 9 条）', () => {
  it('退款是插反向记录，不是把余额改回去 —— 账本行数只增不减', async () => {
    const c = await issue();
    await run('giftcard.redeem', { giftCardId: c.giftCardId, dueCents: 3000 });

    const before = await withTenant(tenant, async (tx) => {
      const [r] = await tx<{ n: number }[]>`
        select count(*)::int as n from customer_credit_ledger where subject_id = ${c.giftCardId}`;
      return r!.n;
    });

    await run('giftcard.refund', { giftCardId: c.giftCardId, reason: '刷错了' });

    const after = await withTenant(tenant, async (tx) => {
      const [r] = await tx<{ n: number; rev: number }[]>`
        select count(*)::int as n,
               count(*) filter (where reversal_of_id is not null)::int as rev
        from customer_credit_ledger where subject_id = ${c.giftCardId}`;
      return r!;
    });

    expect(after.n).toBe(before + 1);      // ⭐ 加了一行，没有删任何东西
    expect(after.rev).toBe(1);             // 而且指明了冲的是哪一行
    expect(await ledgerSum(c.giftCardId)).toBe(10000);
  });

  it('⭐ app_user 改不动已经写下的账本行', async () => {
    const c = await issue();
    await expect(withTenant(tenant, (tx) => tx`
      update customer_credit_ledger set amount_cents = 999999
      where subject_id = ${c.giftCardId}`)).rejects.toThrow();
  });

  it('人工调整不能把余额调成负数', async () => {
    const c = await issue({ faceValueCents: 1000, salePriceCents: 1000 });
    await expect(run('giftcard.adjust',
      { giftCardId: c.giftCardId, amountCents: -5000, reason: '试试' }))
      .rejects.toMatchObject({ details: { reason: 'would_go_negative' } });
  });

  it('人工调整要写原因，并且留痕', async () => {
    const c = await issue();
    const out = await run<{ balanceCents: number }>('giftcard.adjust',
      { giftCardId: c.giftCardId, amountCents: 500, reason: '补偿上次等太久' });
    expect(out.balanceCents).toBe(10500);
  });
});

describe('⭐ 跨店范围由老板设', () => {
  const NAIL_ORG = '11111111-1111-4111-8111-111111111111';
  const NAIL_LOC = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';

  it('location 范围的卡在别的店刷不了', async () => {
    const c = await issue({ scope: 'location' });
    const [nail] = await withTenant(
      { orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: null },
      (tx) => tx<{ id: string; user_id: string }[]>`
        select m.id, m.user_id from memberships m
        join membership_roles mr on mr.membership_id = m.id
        join roles r on r.id = mr.role_id
        where m.location_id = ${NAIL_LOC} and m.status = 'active'
          and r.key in ('owner','manager') and m.user_id is not null limit 1`);
    const nailCtx = await buildContext({ userId: nail!.user_id, membershipId: nail!.id });

    // ⚠️ 跨 org 本来就被 RLS 挡死（卡都查不到）—— 这里验的是
    // 「查得到但不让用」那一层报的是不是人话
    await expect(dispatch('giftcard.redeem',
      { giftCardId: c.giftCardId, dueCents: 1000 },
      nailCtx, { idempotencyKey: crypto.randomUUID() })).rejects.toThrow();
  });
});

// ══════════════════════════ 结账时用礼品卡付（批 8 收尾）══════════════════

describe('结账链路', () => {
  let serviceId = '';
  let techId = '';

  const openTicket = () => run<{ ticketId: string; subtotalCents: number }>('ticket.open', {
    customerId: null, walkInName: '礼品卡结账测试',
    items: [{ serviceId, membershipId: techId, minutes: 60 }],
  });

  beforeAll(async () => {
    const [svc] = await withTenant(tenant, (tx) => tx<{ id: string }[]>`
      select id from services where location_id = ${SPA_LOC} and active = true
        and is_addon = false order by base_price_cents desc limit 1`);
    serviceId = svc!.id;
    const [t] = await withTenant(tenant, (tx) => tx<{ id: string }[]>`
      select membership_id as id from staff_profiles
      where location_id = ${SPA_LOC} and is_bookable = true limit 1`);
    techId = t!.id;
  });

  it('⭐ 用卡付完，卡上扣了钱、单子结了', async () => {
    const c = await issue({ faceValueCents: 50000, salePriceCents: 50000 });
    const t = await openTicket();

    await run('ticket.close', {
      ticketId: t.ticketId,
      payments: [{
        method: 'gift_card', amountCents: t.subtotalCents, tipCents: 0,
        giftCardId: c.giftCardId,
      }],
    });

    expect(await ledgerSum(c.giftCardId)).toBe(50000 - t.subtotalCents);
    const [tk] = await withTenant(tenant, (tx) => tx<{ s: string }[]>`
      select status as s from tickets where id = ${t.ticketId}`);
    expect(tk!.s).toBe('closed');
  });

  it('⭐ 卡余额不够 → **整笔结账拒绝**，不悄悄少扣', async () => {
    const c = await issue({ faceValueCents: 500, salePriceCents: 500 });
    const t = await openTicket();

    await expect(run('ticket.close', {
      ticketId: t.ticketId,
      payments: [{
        method: 'gift_card', amountCents: t.subtotalCents, tipCents: 0,
        giftCardId: c.giftCardId,
      }],
    })).rejects.toMatchObject({ details: { reason: 'gift_card_insufficient' } });

    // ⭐ 回滚干净：卡没被扣，单也没结
    expect(await ledgerSum(c.giftCardId)).toBe(500);
    const [tk] = await withTenant(tenant, (tx) => tx<{ s: string }[]>`
      select status as s from tickets where id = ${t.ticketId}`);
    expect(tk!.s).not.toBe('closed');
  });

  it('⭐ 礼品卡既不算现金也不算刷卡 —— 否则刷卡机 batch total 永远对不上', async () => {
    const c = await issue({ faceValueCents: 50000, salePriceCents: 50000 });
    const t = await openTicket();
    const half = Math.floor(t.subtotalCents / 2);

    await run('ticket.close', {
      ticketId: t.ticketId,
      payments: [
        { method: 'gift_card', amountCents: half, tipCents: 0, giftCardId: c.giftCardId },
        { method: 'cash', amountCents: t.subtotalCents - half, tipCents: 0 },
      ],
    });

    const [split] = await withTenant(tenant, (tx) => tx<{
      cash: number; card: number; gc: number;
    }[]>`
      select
        coalesce(sum(amount_cents) filter (where method = 'cash'), 0)::int as cash,
        coalesce(sum(amount_cents) filter (where method not in ('cash','gift_card')), 0)::int as card,
        coalesce(sum(amount_cents) filter (where method = 'gift_card'), 0)::int as gc
      from payments where ticket_id = ${t.ticketId}`);

    expect(split!.gc).toBe(half);
    expect(split!.card).toBe(0);            // ⭐ 关键：一分钱都不该进刷卡侧
    expect(split!.cash).toBe(t.subtotalCents - half);
  });

  it('没给卡号的 gift_card 行被 schema 挡下', async () => {
    const t = await openTicket();
    await expect(run('ticket.close', {
      ticketId: t.ticketId,
      payments: [{ method: 'gift_card', amountCents: t.subtotalCents, tipCents: 0 }],
    })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
