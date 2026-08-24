/**
 * 断档的日子（0032）：整天不用系统，第二天回来还能把账说清楚。
 *
 * 这一组测试守的是一句话：**「那天做了 0 块」和「那天没人记」不是同一件事。**
 *
 * 混为一谈的代价不是少个数字，是老板某天发现周报是错的 ——
 * 从那一刻起他不再信这个系统里的任何数字。断档本身不致命，
 * 因断档而失去信任才致命。所以这里每一条断言都在盯同一件事：
 * 报表有没有**如实交代自己缺了哪几天**。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { withTenant, closeDb } from '@gf/db';
import { AppError } from '@gf/contracts';
import { buildContext } from './actor';
import { dispatch } from './bus';
import { loadReport, eachDate, type DayStatus } from './queries/money';
import './handlers/ticket';
import './handlers/dayclose';

const SPA_ORG = '22222222-2222-4222-8222-222222222222';
const SPA_LOC = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const tenant = { orgId: SPA_ORG, locationId: SPA_LOC, membershipId: null };

let owner = '';
/** 这次运行专用的一段连续日期。见 allocDates() */
let D: string[] = [];

async function ctxFor(membershipId: string) {
  const [r] = await withTenant(tenant, (tx) => tx<{ user_id: string }[]>`
    select user_id from memberships where id = ${membershipId}`);
  return buildContext({ userId: r!.user_id, membershipId });
}
const run = async <T>(name: string, input: unknown, ctx: Awaited<ReturnType<typeof ctxFor>>) =>
  (await dispatch<T>(name, input, ctx, { idempotencyKey: randomUUID() })).result;

/** 工单要停到哪儿去。比任何一次运行分配到的日期都早，永远不会被复用 */
const TICKET_PARK = '1980-01-01';

/**
 * 给这次运行分配 n 个干净的连续日期。**整个文件只调一次。**
 *
 * 为什么要这么绕：`day_closes` 有 (location, business_date) 唯一索引，
 * 而财务表对 app_user **删不掉**（宪法第 9 条）—— 测试用的正是 app_user，
 * 换个角色跑就证明不了任何事。所以只能每次往后挪，不能清理。
 *
 * 挪到 1999-01-01 之前那段「停放区」：那里是 money.test.ts 停放旧数据的地方，
 * 和真实数据（> 1999）隔得干干净净。取当前最大值 + 1 起步，
 * 和 money.test.ts 用的是同一套单调推进的算法，两边交替跑也不会撞。
 *
 * ⚠️ 必须**同时**看 day_closes 和 tickets 的最大值。
 * 只看 day_closes 的话，某次跑到一半失败留下的一张工单会停在停放区里，
 * 下一次刚好分配到那一天，`markDay` 就会以 DAY_HAS_REAL_RECORDS 拒绝 ——
 * 而那其实是 guard 在正确工作，只是看起来极像产品 bug。这个坑踩过一次。
 */
async function allocDates(n: number): Promise<string[]> {
  const [mx] = await withTenant(tenant, (tx) => tx<{ d: string }[]>`
    select greatest(
      coalesce((select max(business_date) from day_closes
                 where location_id = ${SPA_LOC} and business_date < '1999-01-01'),
               '1990-01-01'),
      coalesce((select max(business_date) from tickets
                 where location_id = ${SPA_LOC}
                   and business_date < '1999-01-01'
                   and business_date > ${TICKET_PARK}),
               '1990-01-01')
    )::text as d`);
  const [y, m, d] = mx!.d.split('-').map(Number);
  return Array.from({ length: n }, (_, i) =>
    new Date(Date.UTC(y!, m! - 1, d! + 1 + i)).toISOString().slice(0, 10));
}

const statusesOf = (byDay: Array<{ key: string; status: DayStatus }>, dates: string[]) =>
  dates.map((d) => byDay.find((r) => r.key === d)?.status);

/** 主流程用的那 5 天（D 一共 8 天，后 3 天是 guard 专用的） */
const MAIN = () => D.slice(0, 5);

beforeAll(async () => {
  const [o] = await withTenant(tenant, (tx) => tx<{ membership_id: string }[]>`
    select membership_id from staff_profiles
    where location_id = ${SPA_LOC} and display_name->>'en' = 'Owner'`);
  owner = o!.membership_id;
  // ⭐ 一次分配 8 天，用例之间不再各分各的：
  // 中途再分配会拿到「刚被前一个用例写过的那一天」，
  // 于是后面的断言读到的是别人留下的状态，排查起来极像产品 bug
  D = await allocDates(8);
});

afterAll(async () => { await closeDb(); });

// ───────────────────────────────────────────────────────────── 报表铺满区间

describe('报表：零 ≠ 空白', () => {
  it('⭐ 没记的那天必须出现在 byDay 里，而不是消失', async () => {
    const ctx = await ctxFor(owner);
    const r = await withTenant(tenant, (tx) => loadReport(tx, ctx, D[0]!, D[4]!));

    // 改这一行之前，byDay 是 group by business_date 的结果 ——
    // 五天一条数据都没有的话，它是个空数组，前端只能显示「无数据」，
    // 而合计静默为 0，看不出这个 0 是「没生意」还是「没记录」
    expect(r.byDay).toHaveLength(5);
    expect(r.byDay.map((d) => d.key)).toEqual(MAIN());
    expect(statusesOf(r.byDay, MAIN())).toEqual(
      ['no_record', 'no_record', 'no_record', 'no_record', 'no_record']);
  });

  it('区间的完整度要如实报出来，界面才有办法说「这个数是残的」', async () => {
    const ctx = await ctxFor(owner);
    const r = await withTenant(tenant, (tx) => loadReport(tx, ctx, D[0]!, D[4]!));

    expect(r.coverage.daysInRange).toBe(5);
    expect(r.coverage.daysMissing).toBe(5);
    expect(r.coverage.daysUnhandled).toBe(5);
    expect(r.coverage.complete).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────── 三个断档终态

describe('标记一个断档的日子', () => {
  it('「那天没营业」是真实的 0 —— 算完整，不算缺', async () => {
    const ctx = await ctxFor(owner);
    const out = await run<{ status: string; earningsStillMissing: boolean }>(
      'dayclose.markDay',
      { businessDate: D[0]!, mark: 'no_business', note: '下雪关门' }, ctx);

    expect(out.status).toBe('no_business');
    // 那天本来就没有提成可算，这不叫「缺」
    expect(out.earningsStillMissing).toBe(false);

    const r = await withTenant(tenant, (tx) => loadReport(tx, ctx, D[0]!, D[0]!));
    expect(r.byDay[0]!.status).toBe('no_business');
    expect(r.byDay[0]!.grossCents).toBe(0);
    expect(r.byDay[0]!.note).toBe('下雪关门');
    expect(r.coverage.daysComplete).toBe(1);
    expect(r.coverage.daysMissing).toBe(0);
    // ⭐ 没营业的天不缺任何东西，区间是完整的
    expect(r.coverage.complete).toBe(true);
  });

  it('⭐「用纸记的，不补了」是空白 —— 钱不许进合计', async () => {
    const ctx = await ctxFor(owner);
    await run('dayclose.markDay',
      { businessDate: D[1]!, mark: 'paper_only', note: 'Lily 请假，我用本子记的' }, ctx);

    const r = await withTenant(tenant, (tx) => loadReport(tx, ctx, D[1]!, D[1]!));
    expect(r.byDay[0]!.status).toBe('paper_only');
    // 那天是有生意的，只是数不在系统里。把它当 0 加进合计等于编造一个事实
    expect(r.coverage.daysMissing).toBe(1);
    expect(r.coverage.complete).toBe(false);
    // 但它**不再是待办**：人已经明确决定过了，别再去烦他
    expect(r.coverage.daysUnhandled).toBe(0);
  });

  it('⭐ 补总数进合计，但提成依然是空的 —— 这件事必须能被查询到', async () => {
    const ctx = await ctxFor(owner);
    const out = await run<{ earningsStillMissing: boolean }>('dayclose.markDay', {
      businessDate: D[2]!, mark: 'summary_only',
      summary: {
        grossCents: 182_000, cashCents: 64_000, cardCents: 118_000,
        tipCashCents: 12_000, tipCardCents: 9_800,
      },
      note: '照着本子敲的',
    }, ctx);
    expect(out.earningsStillMissing).toBe(true);

    const r = await withTenant(tenant, (tx) => loadReport(tx, ctx, D[2]!, D[2]!));
    const day = r.byDay[0]!;
    expect(day.status).toBe('summary_only');
    expect(day.grossCents).toBe(182_000);
    expect(day.cashCents).toBe(64_000);
    expect(day.cardCents).toBe(118_000);
    expect(day.tipCents).toBe(21_800);
    expect(day.totalCents).toBe(182_000 + 21_800);
    // ⚠️ 这个 false 是整条链路的重点：营业额补上了，提成没有。
    // 界面必须照着它说清楚，不能让老板以为那天的工资系统能算
    expect(day.hasEarnings).toBe(false);

    // 钱进了合计
    expect(r.summary.grossCents).toBe(182_000);
    // 但区间仍然不算「完整」—— 没有提成明细就是不完整
    expect(r.coverage.daysSummaryOnly).toBe(1);
    expect(r.coverage.complete).toBe(false);

    // 那天一条 earnings 都不该有 —— 补录不许凭空造出提成流水
    const rows = await withTenant(tenant, (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from earnings
      where location_id = ${SPA_LOC} and business_date = ${D[2]!}`);
    expect(rows[0]!.n).toBe(0);
  });

  it('合计只加钱在系统里的天：三种状态混在一个区间里也要算对', async () => {
    const ctx = await ctxFor(owner);
    // D[0] 没营业(0) / D[1] 用纸记的(空白) / D[2] 补了总数(182000) / D[3] D[4] 没记
    const r = await withTenant(tenant, (tx) => loadReport(tx, ctx, D[0]!, D[4]!));

    expect(statusesOf(r.byDay, MAIN())).toEqual(
      ['no_business', 'paper_only', 'summary_only', 'no_record', 'no_record']);
    expect(r.summary.grossCents).toBe(182_000);
    expect(r.coverage).toMatchObject({
      daysInRange: 5, daysComplete: 1, daysSummaryOnly: 1,
      daysMissing: 3, daysUnhandled: 2, complete: false,
    });
  });
});

// ───────────────────────────────────────────────────────────────── 三条 guard

describe('不许把假数据写进历史', () => {
  it('⭐ 那天已经有真实工单 → 拒绝。真实数据比事后的概括可信', async () => {
    const ctx = await ctxFor(owner);
    const [svc] = await withTenant(tenant, (tx) => tx<{ id: string }[]>`
      select id from services where location_id = ${SPA_LOC} order by base_price_cents limit 1`);
    const [staff] = await withTenant(tenant, (tx) => tx<{ membership_id: string }[]>`
      select membership_id from staff_profiles
      where location_id = ${SPA_LOC} and display_name->>'en' <> 'Owner' limit 1`);

    const t = await run<{ ticketId: string }>('ticket.open', {
      customerId: null, walkInName: '断档测试',
      items: [{ serviceId: svc!.id, membershipId: staff!.membership_id, minutes: 60 }],
    }, ctx);

    // 把这张单挪到 D[5]，制造「那天其实有记录」的局面
    await withTenant(tenant, (tx) => tx`
      update tickets set business_date = ${D[5]!} where id = ${t.ticketId}`);

    await expect(
      run('dayclose.markDay', { businessDate: D[5]!, mark: 'no_business' }, ctx),
    ).rejects.toMatchObject({ code: 'DAY_HAS_REAL_RECORDS' });

    // ⚠️ 收尾只挪日期，**不伪造成作废**：作废在库里要求必须有原因
    // （void_needs_reason），硬塞一个 'voided' 会被约束顶回来 ——
    // 而那条约束是对的，它拦的正是「没人说得清为什么的作废」
    await withTenant(tenant, (tx) => tx`
      update tickets set business_date = ${TICKET_PARK} where id = ${t.ticketId}`);
  });

  it('明天「没营业」不是记录，是计划 → 拒绝', async () => {
    const ctx = await ctxFor(owner);
    const future = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    await expect(
      run('dayclose.markDay', { businessDate: future, mark: 'no_business' }, ctx),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('说要补总数却一个数都不给 → 拒绝（这种记录比空白更坏）', async () => {
    const ctx = await ctxFor(owner);
    await expect(
      run('dayclose.markDay', { businessDate: D[6]!, mark: 'summary_only' }, ctx),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('现金加刷卡超过总额 → 拒绝（八成是敲错了一位）', async () => {
    const ctx = await ctxFor(owner);
    await expect(
      run('dayclose.markDay', {
        businessDate: D[7]!, mark: 'summary_only',
        summary: { grossCents: 10_000, cashCents: 8_000, cardCents: 8_000 },
      }, ctx),
    ).rejects.toBeInstanceOf(AppError);
  });
});

// ────────────────────────────────────────────────────────────────── 纯函数

describe('eachDate', () => {
  it('含首尾', () => {
    expect(eachDate('2026-03-01', '2026-03-04'))
      .toEqual(['2026-03-01', '2026-03-02', '2026-03-03', '2026-03-04']);
  });

  it('同一天回一天', () => {
    expect(eachDate('2026-03-01', '2026-03-01')).toEqual(['2026-03-01']);
  });

  it('⭐ 夏令时切换那两天不多不少', () => {
    // 美东 2026-03-08 跳表。用本地时间加一天的话，这里会少一天或重复一天 ——
    // 而那正好是老板会拿来跟去年同期比的日子
    expect(eachDate('2026-03-07', '2026-03-09'))
      .toEqual(['2026-03-07', '2026-03-08', '2026-03-09']);
    // 秋天回拨那次
    expect(eachDate('2026-10-31', '2026-11-02'))
      .toEqual(['2026-10-31', '2026-11-01', '2026-11-02']);
  });

  it('闰年二月不缺那一天', () => {
    const feb = eachDate('2028-02-27', '2028-03-01');
    expect(feb).toEqual(['2028-02-27', '2028-02-28', '2028-02-29', '2028-03-01']);
  });

  it('起点晚于终点时回空数组，不死循环', () => {
    expect(eachDate('2026-03-05', '2026-03-01')).toEqual([]);
  });
});
