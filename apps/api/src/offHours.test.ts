/**
 * 非营业时间能不能约（0046）
 *
 * ## 这一组守的那句话
 *
 * 「**九点半开门，熟客说她八点半要来 —— 前台可以答应，官网不可以卖。**」
 *
 * 两半都要成立才算对：
 *   · 只做前半句 → 老板通融不了，客人的选择变成「不来」
 *   · 只做后半句 → 官网把没人在的时段挂出去，客人到门口才发现锁着
 *
 * ## `OUTSIDE_BUSINESS_HOURS` 之前是个空壳
 *
 * 这个错误码从第一天就在错误码表、在 `OVERRIDABLE_CODES`、在前台两份
 * i18n 里 —— 但代码里从来没有人抛过它。所以这里第一条测的不是新功能，
 * 是「闸门确实存在」。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { withTenant, closeDb, jsonb } from '@gf/db';
import { AppError } from '@gf/contracts';
import { dispatch } from './bus';
import { buildContext } from './actor';
import './handlers/appointment';
import './handlers/setup';

const NAIL_ORG = '11111111-1111-4111-8111-111111111111';
const NAIL_LOC = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const tenant = { orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: null };

let deskCtx: Awaited<ReturnType<typeof buildContext>>;
let ownerCtx: Awaited<ReturnType<typeof buildContext>>;
let gelService = '';
let customerId = '';
/** 这次运行用的那个周一。种子店周一 09:30–19:30 */
let MONDAY = '';
/** 跑之前 settings.off_hours 长什么样，跑完原样放回去 */
let savedOffHours: unknown = null;

/** 门店墙上时间 → UTC。八月的纽约是 EDT，冬天是 EST —— 用真实偏移算，别硬编 */
function nyc(date: string, hh: number, mm = 0): string {
  const guess = Date.UTC(
    Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)), hh, mm);
  let t = guess;
  for (let i = 0; i < 2; i++) {
    const p = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(t));
    const g = (k: string) => Number(p.find((x) => x.type === k)!.value);
    t += guess - Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'));
  }
  return new Date(t).toISOString();
}

async function ctxFor(name: string) {
  const [r] = await withTenant(tenant, (tx) => tx<{ id: string; user_id: string }[]>`
    select m.id, m.user_id from memberships m
    join staff_profiles sp on sp.membership_id = m.id
    where m.location_id = ${NAIL_LOC} and m.status = 'active'
      and sp.display_name->>'en' = ${name}`);
  return buildContext({ userId: r!.user_id, membershipId: r!.id });
}

const run = <T>(name: string, input: unknown, ctx = deskCtx) =>
  dispatch<T>(name, input, ctx, { idempotencyKey: randomUUID() }).then((r) => r.result);

/** 建一单。`source` 决定走的是前台还是公开渠道 —— 这一组的分水岭就在这里 */
const book = async (startsAt: string, opts: { source?: string; override?: unknown } = {}) => {
  const out = await run<{ appointmentId: string }>('appointment.create', {
    customerId,
    items: [{ serviceId: gelService, addonIds: [], membershipId: null, startsAt, details: {} }],
    partySize: 1, source: opts.source ?? 'desk',
    ...(opts.override ? { override: opts.override } : {}),
  });
  created.push(out.appointmentId);
  return out;
};

const setPolicy = (over: Record<string, unknown> = {}) =>
  run('location.saveOffHours', {
    enforce: true, beforeOpenMinutes: 0, afterCloseMinutes: 0, beyond: 'warn', ...over,
  }, ownerCtx);

const codeOf = async (p: Promise<unknown>) => {
  try { await p; return 'NO_ERROR'; } catch (e) { return (e as AppError).code; }
};
const errOf = async (p: Promise<unknown>) => {
  try { await p; throw new Error('本该抛错'); } catch (e) { return e as AppError; }
};

beforeAll(async () => {
  deskCtx = await ctxFor('Mia');    // 前台
  ownerCtx = await ctxFor('Amy');   // 店长，有 settings.manage

  const [svc] = await withTenant(tenant, (tx) => tx<{ id: string }[]>`
    select id from services where name->>'en' = 'Gel Manicure' and location_id = ${NAIL_LOC}`);
  gelService = svc!.id;

  const [cust] = await withTenant(tenant, (tx) => tx<{ id: string }[]>`
    select id from customers where display_name = 'Lisa Chen' limit 1`);
  customerId = cust!.id;

  const [loc] = await withTenant(tenant, (tx) => tx<{ off: unknown }[]>`
    select settings->'off_hours' as off from locations where id = ${NAIL_LOC}`);
  savedOffHours = loc!.off;

  /*
   * 找一个未来的周一。
   *
   * ⚠️ 不用「明天」：明天是星期几取决于跑测试的日子，而周日的营业时间
   * （10:00–18:00）和周一不一样 —— 那样写出来的断言会一周对六天。
   * 往后推 30 天起步，也避开 `min_minutes_ahead` 之类的近端护栏。
   */
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 30);
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  MONDAY = d.toISOString().slice(0, 10);

  /*
   * 把这一天清干净。上一轮跑到一半失败会留下几单，而它们全都堆在
   * 早上七点那一格 —— 下一轮再建就撞 `LOCATION_OVER_CAPACITY`，
   * 报出来的错和营业时间毫无关系，查起来极费劲。这个坑踩过一次。
   */
  await withTenant(tenant, (tx) => tx`
    delete from appointments
    where location_id = ${NAIL_LOC} and business_date = ${MONDAY}`);
});

const created: string[] = [];

afterAll(async () => {
  // 自己建的单自己收走。留着会顶掉后面文件的容量判断，
  // 而那种失败看起来和营业时间毫无关系（这个坑这个仓库踩过）
  if (created.length) {
    await withTenant(tenant, (tx) => tx`
      delete from appointments where id = any(${created})`);
  }
  // ⚠️ 一定要放回去。这几条会改门店 settings，留着会让别的文件
  // 在「闸门开着」的世界里跑，而它们的失败看起来和营业时间毫无关系
  await withTenant(tenant, (tx) => tx`
    update locations set settings = jsonb_set(
      settings, '{off_hours}', ${jsonb(savedOffHours ?? {})}::jsonb, true)
    where id = ${NAIL_LOC}`);
  await closeDb();
});

describe('闸门关着（默认，也就是 0046 之前的世界）', () => {
  it('前台想约几点约几点 —— 早上七点也照建', async () => {
    await setPolicy({ enforce: false });
    const out = await book(nyc(MONDAY, 7));
    expect(out.appointmentId).toBeTruthy();
  });
});

describe('闸门开着', () => {
  it('营业时间内照常放行', async () => {
    await setPolicy();
    await expect(book(nyc(MONDAY, 11))).resolves.toBeTruthy();
  });

  it('九点半开门，前台约七点 → OUTSIDE_BUSINESS_HOURS', async () => {
    await setPolicy();
    const err = await errOf(book(nyc(MONDAY, 7)));
    expect(err.code).toBe('OUTSIDE_BUSINESS_HOURS');
    expect((err.details as { issue: { code: string } }).issue.code).toBe('BEFORE_OPEN');
    expect((err.details as { overridable: boolean }).overridable).toBe(true);
  });

  it('带 reason 重试就放行 —— 和超卖完全同一个交互', async () => {
    await setPolicy();
    await expect(book(nyc(MONDAY, 7), { override: { reason: 'guest_requested' } }))
      .resolves.toBeTruthy();
  });

  it('⭐ 老板放开开门前一小时 → 八点半那一单不用 reason 就进去了', async () => {
    await setPolicy({ beforeOpenMinutes: 60 });
    await expect(book(nyc(MONDAY, 8, 30))).resolves.toBeTruthy();
    // 宽限是一小时，八点整仍然要 reason —— 边界不能顺手多给
    expect(await codeOf(book(nyc(MONDAY, 8)))).toBe('OUTSIDE_BUSINESS_HOURS');
  });

  it('看的是结束时刻：19:00 开始的 60 分钟做到 20:00，超了打烊时间', async () => {
    await setPolicy();
    expect(await codeOf(book(nyc(MONDAY, 19)))).toBe('OUTSIDE_BUSINESS_HOURS');
    await setPolicy({ afterCloseMinutes: 60 });
    await expect(book(nyc(MONDAY, 19))).resolves.toBeTruthy();
  });

  it('beyond=block → 连 reason 都不给', async () => {
    await setPolicy({ beyond: 'block' });
    const err = await errOf(book(nyc(MONDAY, 7), { override: { reason: 'guest_requested' } }));
    expect(err.code).toBe('OUTSIDE_BUSINESS_HOURS');
    expect((err.details as { overridable: boolean }).overridable).toBe(false);
  });
});

describe('⭐ 官网和电话 AI：这条线上没有人', () => {
  it('公开渠道不吃宽限 —— 老板放开一小时，官网八点半照样订不进去', async () => {
    await setPolicy({ beforeOpenMinutes: 60 });
    const err = await errOf(book(nyc(MONDAY, 8, 30), { source: 'web' }));
    expect(err.code).toBe('OUTSIDE_BUSINESS_HOURS');
    expect((err.details as { overridable: boolean }).overridable).toBe(false);
  });

  it('公开渠道也不吃 reason —— 越界就是越界', async () => {
    await setPolicy({ beforeOpenMinutes: 60 });
    expect(await codeOf(book(nyc(MONDAY, 8, 30),
      { source: 'phone_ai', override: { reason: 'guest_requested' } })))
      .toBe('OUTSIDE_BUSINESS_HOURS');
  });

  it('⭐ 而且不看老板那个总开关：闸门关着，官网仍然订不到营业时间外', async () => {
    /*
     * 老板那个开关管的是「前台能不能通融」，不是
     * 「要不要把没人在的时段挂到网上卖」—— 后者从来不是一个选项。
     */
    await setPolicy({ enforce: false });
    expect(await codeOf(book(nyc(MONDAY, 7), { source: 'web' })))
      .toBe('OUTSIDE_BUSINESS_HOURS');
    // 同一时刻、同一个门店配置，前台建就是好的
    await expect(book(nyc(MONDAY, 7))).resolves.toBeTruthy();
  });
});

describe('开关本身', () => {
  it('营业时间还没配就打开闸门 → 当场拦下', async () => {
    /*
     * 空的 `business_hours` 在引擎里被当成「还没配」而放行，所以打开开关
     * 会是一个什么都不发生的操作 —— 老板却以为自己设好了。
     */
    const [saved] = await withTenant(tenant, (tx) => tx<{ h: unknown }[]>`
      select business_hours as h from locations where id = ${NAIL_LOC}`);
    await withTenant(tenant, (tx) => tx`
      update locations set business_hours = '{}'::jsonb where id = ${NAIL_LOC}`);
    try {
      const err = await errOf(setPolicy({ enforce: true }));
      expect(err.code).toBe('VALIDATION_FAILED');
      expect((err.details as { reason: string }).reason).toBe('business_hours_not_configured');
      // 关掉是随时可以的 —— 不然老板会被自己锁在一个改不了的状态里
      await expect(setPolicy({ enforce: false })).resolves.toBeTruthy();
    } finally {
      await withTenant(tenant, (tx) => tx`
        update locations set business_hours = ${jsonb(saved!.h)}::jsonb where id = ${NAIL_LOC}`);
    }
  });
});
