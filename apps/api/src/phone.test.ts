/**
 * Phase 2 验收：AI 电话接单这条链路。
 *
 * 不打真电话 —— 直接构造「Telnyx 会发来什么」，验的是它之后的每一步。
 * 每一条都在问同一个问题：**这一行检查没有的话，会出什么事？**
 *
 *   · 伪造签名能不能往复核队列灌预约
 *   · AI 能不能建出一条真预约（不能，它只有 call.draft）
 *   · AI 编一个「明天四点」能不能蒙混过关（不能，排期引擎会驳回）
 *   · 同号多客户会不会被自动挑一个（不会，决策 21）
 *   · webhook 重投会不会把通话分钟数记两遍（不会，那是多收钱）
 *   · 号码没绑门店时会不会落到一个猜出来的租户上（不会，404）
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { randomUUID, generateKeyPairSync, sign as edSign, createHash } from 'node:crypto';
import { withTenant, closeDb, tenantForPhoneNumber } from '@gf/db';
import { buildContext } from './actor';
import { dispatch } from './bus';
import { loadCallDrafts } from './queries/callDrafts';
import { loadCalls } from './queries/calls';
import { buildServer } from './server';
import './handlers/phone';

const NAIL_ORG = '11111111-1111-4111-8111-111111111111';
const NAIL_LOC = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const tenant = { orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: null };

const AI_LINE = '+15125550199';

let ctx: Awaited<ReturnType<typeof buildContext>>;
let app: ReturnType<typeof buildServer>;
let shopToken = '';
let bookable: Array<{ id: string; gender: string | null }> = [];
let catalog: Array<{ id: string; name: string; duration_min: number; is_addon: boolean }> = [];

/** 三周后的三天：排班 / 不排班 / 再排班（改期建议那条路要用） */
const dayAfter = (n: number): string => {
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const DAY_OPEN = dayAfter(21);
const DAY_SHUT = dayAfter(22);
const DAY_LATER = dayAfter(23);
/** 门店墙上时间的正午。纽约夏令时 = 16:00Z，冬令时 17:00Z —— 都落在营业时间内 */
const noonAt = (date: string) => `${date}T16:30:00.000Z`;

/** 冒充 Telnyx 需要它的私钥；测试里我们自己生成一对，公钥喂给服务端 */
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const rawPublicB64 = publicKey.export({ type: 'spki', format: 'der' })
  .subarray(12).toString('base64');

beforeAll(async () => {
  process.env['TELNYX_PUBLIC_KEY'] = rawPublicB64;

  const [m] = await withTenant(tenant, (tx) => tx<{ id: string; user_id: string }[]>`
    select m.id, m.user_id from memberships m
    join membership_roles mr on mr.membership_id = m.id
    join roles r on r.id = mr.role_id
    where m.location_id = ${NAIL_LOC} and m.status = 'active'
      and r.key in ('owner','manager') limit 1`);
  ctx = await buildContext({ userId: m!.user_id, membershipId: m!.id });

  /*
   * ⭐ 建 AI 线时会自动生成一串工具 token（sql/0036）——
   * 明文**只有这一次**拿得到，库里只有摘要。
   * 拿不到它，下面每一个工具调用都会 401。
   */
  const line = await run<{ toolToken: string | null }>(
    'location.savePhoneLine',
    // ⚠️ 一定要 rotate：上一次跑挂在半路的话这条线还在，
    // 而**已经有 token 的线不会再返回明文** —— 那样这一整个文件会在
    // beforeAll 里死掉，报错却指向一个和真正原因无关的地方
    { e164: AI_LINE, purpose: 'ai_voice', rotateToolToken: true });
  shopToken = line.toolToken!;
  expect(shopToken).toMatch(/^st_/);

  /*
   * ⭐ 自己排一段班，不蹭种子里那几天。
   *
   * 空档是算出来的：没有 published 的班，`find_slots` 永远返回空数组 ——
   * 而那个表现和「今天真的约满了」一模一样，测试会以为自己在验一件事，
   * 其实什么都没验到。用三周后的固定日期，也就不受「跑测试的时候
   * 店里已经打烊了」影响。
   *
   * DAY_OPEN 排班、DAY_SHUT 不排、DAY_LATER 再排 —— 后两个是留给
   * 「那天没空档 → 往后找三天」那条路的。
   */
  bookable = await withTenant(tenant, (tx) => tx<{ id: string; gender: string | null }[]>`
    select sp.membership_id as id, sp.gender
    from staff_profiles sp
    join memberships m on m.id = sp.membership_id and m.status = 'active'
    where sp.location_id = ${NAIL_LOC} and sp.is_bookable = true
    order by sp.display_name->>'en'`);

  for (const date of [DAY_OPEN, DAY_LATER]) {
    for (const st of bookable) {
      await run('shift.set', {
        membershipId: st.id, businessDate: date, action: 'work',
        startMin: 10 * 60, endMin: 18 * 60,
      });
    }
  }
  await run('shift.publish', { fromDate: DAY_OPEN, toDate: DAY_LATER });

  catalog = await withTenant(tenant, (tx) => tx<{
    id: string; name: string; duration_min: number; is_addon: boolean;
  }[]>`
    select id, name->>'en' as name, duration_min, is_addon
    from services where location_id = ${NAIL_LOC} and active = true`);

  app = buildServer();
  await app.ready();
});

afterAll(async () => {
  // beforeAll 挂了的话 app 还是 undefined，这里再抛一次会把真正的报错盖掉
  await app?.close();
  await withTenant(tenant, async (tx) => {
    await tx`delete from call_drafts where location_id = ${NAIL_LOC}`;
    /*
     * ⚠️ 只删这个测试自己建的那一条，**不要**按门店整片删。
     *
     * 种子里给两家店各绑了一个 AI 号（不绑的话六个电话工具全是 404）。
     * 按 location_id 删会把种子那条一起带走，于是「跑完测试，
     * 电话工具就全 404 了」，而下一个人只会以为是自己刚改的代码坏了。
     */
    await tx`delete from phone_lines where location_id = ${NAIL_LOC} and e164 = ${AI_LINE}`;
    // 这个测试自己建的单和自己排的班，走的时候带走
    await tx`delete from appointment_items where appointment_id in (
               select id from appointments
               where location_id = ${NAIL_LOC} and business_date in (${DAY_OPEN}, ${DAY_LATER}))`;
    await tx`delete from appointments
             where location_id = ${NAIL_LOC} and business_date in (${DAY_OPEN}, ${DAY_LATER})`;
    await tx`delete from shifts
             where location_id = ${NAIL_LOC} and business_date in (${DAY_OPEN}, ${DAY_LATER})`;
    await tx`delete from customers
             where primary_location_id = ${NAIL_LOC} and display_name = ${'电话测试'}`;

    /*
     * ⭐ 把种子店那两条线原样放回去。
     *
     * 一家店只有**一条** active 的 `ai_voice` 线（upsert 的冲突键是
     * location + purpose），所以上面 `savePhoneLine` 建测试号的那一下，
     * 把种子里的 `+12125550123` 顶掉了；「店家的两个号码」那几条用例
     * 又把 `main` 换成了别的号。
     *
     * 不放回去的表现是：**跑完一次测试，本地那个假电话脚本就全 404** ——
     * 而这个因果关系隔一天就没人想得起来了。
     *
     * 摘要按种子那套算法重算（`st_dev_<locationId 去掉横线>`），
     * 否则号码回来了、token 对不上，401 比 404 更难查。
     */
    await tx`delete from phone_lines where location_id = ${NAIL_LOC}`;
    const seedDigest = createHash('sha256')
      .update(`st_dev_${NAIL_LOC.replace(/-/g, '')}`, 'utf8').digest('hex');
    await tx`insert into phone_lines (org_id, location_id, e164, purpose, tool_token_digest)
             values (${NAIL_ORG}, ${NAIL_LOC}, ${'+12125550123'}, 'ai_voice', ${seedDigest}),
                    (${NAIL_ORG}, ${NAIL_LOC}, ${'+12125550100'}, 'main', null)`;
  });
  await closeDb();
});

const run = async <T>(name: string, input: unknown, key: string = randomUUID()) =>
  (await dispatch<T>(name, input, ctx, { idempotencyKey: key })).result;

/**
 * 电话 AI 那个系统上下文 —— 和 telnyx/routes.ts 的 systemContext 一致。
 *
 * `membershipId: null`（电话背后没有人）、`actorKind: 'api'`、
 * 权限只有 call.draft + 三个只读。用它跑才是真实路径；
 * 拿店长的上下文跑 call.record 会因为店长权限更大而【通过】，
 * 那就等于没测到「AI 的权限有多窄」。
 */
const sysCtx = (): typeof ctx => ({
  ...ctx,
  membershipId: null,
  actorKind: 'api',
  // ⚠️ 必须和 telnyx/routes.ts 的 PHONE_AI_PERMISSIONS 一字不差。
  // 少写一条这里就成了「测了一个比真实更窄的身份」——
  // 真实身份能干而这里干不了的事，永远测不出来
  permissions: new Set([
    'appointment.write', 'call.draft',
    'appointment.read', 'customer.read', 'schedule.read',
  ]),
});

const runAsPhone = async <T>(name: string, input: unknown, key: string = randomUUID()) =>
  (await dispatch<T>(name, input, sysCtx(), { idempotencyKey: key })).result;

/** 造一条带合法签名的 Telnyx 请求 */
function telnyxCall(url: string, payload: unknown, opts: { badSig?: boolean; skewSec?: number } = {}) {
  // 工具路由的第二把钥匙（sql/0036）。用例自己传了就以它为准 ——
  // 「token 不对会怎样」那几条要的就是覆盖它
  const withToken = payload && typeof payload === 'object'
    ? { shop_token: shopToken, ...payload as Record<string, unknown> }
    : payload;
  const raw = JSON.stringify(withToken);
  const tsSec = Math.floor(Date.now() / 1000) + (opts.skewSec ?? 0);
  const sig = opts.badSig
    ? Buffer.from('forged-signature-that-looks-plausible').toString('base64')
    : edSign(null, Buffer.from(`${tsSec}|${raw}`, 'utf8'), privateKey).toString('base64');

  return app.inject({
    method: 'POST', url,
    headers: {
      'content-type': 'application/json',
      'telnyx-signature-ed25519': sig,
      'telnyx-timestamp': String(tsSec),
    },
    payload: raw,
  });
}

const drafts = (status = 'pending') =>
  withTenant(tenant, (tx) => loadCallDrafts(tx, ctx, status));

// ═══════════════════════════════════════════════════════════════════════════

describe('号码 → 门店', () => {
  it('绑过的号码解析得出门店，且不需要绕过 RLS', async () => {
    const t = await tenantForPhoneNumber(AI_LINE);
    expect(t?.locationId).toBe(NAIL_LOC);
    expect(t?.orgId).toBe(NAIL_ORG);
    expect(t?.name).toBeTruthy();     // 店名要跟着回来，工具的返回里要报出来
  });

  it('⭐ 每个工具的返回都说清是哪家店 —— 入参里没有门店 id，出参里必须有', async () => {
    /*
     * 门店 id 不能当入参（签名是唯一的身份证明，接受 id 等于让任何一次
     * 签名都能点名查任意一家店）。但不告诉调用方落到了谁头上，
     * 「串店」就成了一类没人发现得了的故障。
     */
    for (const [url, payload] of [
      ['/v1/telnyx/tools/lookup_customer', { to: AI_LINE, from: '+15125551234' }],
      ['/v1/telnyx/tools/list_services', { to: AI_LINE }],
      ['/v1/telnyx/tools/list_staff', { to: AI_LINE }],
      ['/v1/telnyx/tools/find_slots', { to: AI_LINE }],
    ] as const) {
      const body = (await telnyxCall(url, payload)).json();
      expect(body.shop.locationId, url).toBe(NAIL_LOC);
      expect(body.shop.name, url).toBeTruthy();
      expect(body.shop.timezone, url).toBe('America/New_York');
    }
  });

  it('⭐ 没绑过的号码解析不出来 —— 别把电话落到一个猜出来的租户上', async () => {
    expect(await tenantForPhoneNumber('+15125550000')).toBeNull();
  });

  it('⭐ 号码维度的上下文只能看到那一行，翻不出整张号码表', async () => {
    // 策略是 `e164 = app_phone_lookup()`：要先说出完整号码才查得到它
    const { withPhoneLine } = await import('@gf/db');
    const all = await withPhoneLine(AI_LINE, (tx) => tx<{ e164: string }[]>`
      select e164 from phone_lines`);
    expect(all).toHaveLength(1);
    expect(all[0]!.e164).toBe(AI_LINE);
  });

  it('同一个号码不能同时绑两家店', async () => {
    // 绑重了 webhook 会随机落到其中一家 —— 无从复现的串店
    const [other] = await withTenant(
      { orgId: NAIL_ORG, locationId: null, membershipId: null },
      (tx) => tx<{ id: string }[]>`
        select id from locations where id <> ${NAIL_LOC} and org_id = ${NAIL_ORG} limit 1`);
    if (!other) return;   // 种子里只有一家店时跳过
    const otherCtx = { ...ctx, locationId: other.id };
    await expect(dispatch('location.savePhoneLine',
      { e164: AI_LINE, purpose: 'ai_voice' }, otherCtx, { idempotencyKey: randomUUID() }))
      .rejects.toMatchObject({ code: 'RESOURCE_CONFLICT' });
  });
});

describe('验签：这条链路唯一的安全要害', () => {
  it('⭐ 伪造签名灌不进复核队列', async () => {
    const before = (await drafts()).pendingCount;
    const res = await telnyxCall('/v1/telnyx/tools/draft_appointment', {
      to: AI_LINE, from: '+15125551234', service_heard: 'gel manicure',
    }, { badSig: true });

    expect(res.statusCode).toBe(401);
    expect((await drafts()).pendingCount).toBe(before);
  });

  it('⭐ 过期签名同样被拒（防重放）', async () => {
    const res = await telnyxCall('/v1/telnyx/tools/lookup_customer',
      { to: AI_LINE, from: '+15125551234' }, { skewSec: -3600 });
    expect(res.statusCode).toBe(401);
  });

  it('⭐ 这几条路由不吃 Bearer token —— 只认签名', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/telnyx/tools/lookup_customer',
      headers: { 'content-type': 'application/json', authorization: 'Bearer whatever' },
      payload: JSON.stringify({ to: AI_LINE }),
    });
    expect(res.statusCode).toBe(401);
  });

  it('真签名通过', async () => {
    const res = await telnyxCall('/v1/telnyx/tools/lookup_customer',
      { to: AI_LINE, from: '+15125551234' });
    expect(res.statusCode).toBe(200);
  });

  it('号码没绑门店 → 404，不是落到某个默认租户', async () => {
    const res = await telnyxCall('/v1/telnyx/tools/lookup_customer',
      { to: '+15125550000', from: '+15125551234' });
    expect(res.statusCode).toBe(404);
  });
});

describe('tool：查空档', () => {
  it('返回的是排期引擎算出来的真空档，并附一句「不许自己推算」', async () => {
    /*
     * ⚠️ 必须钉一个**排过班的日子**（DAY_OPEN），不能不传 around 就查今天。
     * 查今天的话，晚上八点跑测试拿到的是「今天没空档了」——
     * 断言时灵时不灵，而失败信息看起来像是排期引擎坏了。
     */
    const res = await telnyxCall('/v1/telnyx/tools/find_slots', {
      to: AI_LINE, duration_min: 45, around: noonAt(DAY_OPEN),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.slots.length).toBeGreaterThan(0);
    expect(body.guidance).toMatch(/Offer only the times below/);
    // 每个空档都必须带具体是谁有空 —— 「有空」而说不出是谁，前台没法派单
    for (const s of body.slots) expect(s.staff.length).toBeGreaterThan(0);
  });
});

/**
 * docs/14 §4 那张「尚未实现」表上的五项，2026-08-22 补齐。
 *
 * 每一条问的还是同一个问题：**这一行检查没有的话，电话里会说错什么？**
 */
describe('第二把钥匙：每条 AI 线一串不可猜的 token（sql/0036）', () => {
  /*
   * 为什么要有它：门店靠**公开的**被叫号码定位（号码就印在店门口）。
   * 验签一旦被绕过，攻击者可以逐个号码点名查任意一家店。
   * 这串 32 字节随机、只存摘要的东西是那道门后面的第二道。
   *
   * ⚠️ 它**不是门店 id**，也不替代号码 —— 挂机计费那条 webhook
   * 不是工具调用，带不了自定义参数，所以下面第三条盯着「webhook 不要它」。
   */
  it('⭐ 不带 token → 401，而且不告诉你是缺了还是错了', async () => {
    const res = await telnyxCall('/v1/telnyx/tools/list_services',
      { to: AI_LINE, shop_token: undefined });
    expect(res.statusCode).toBe(401);
    expect(res.json().details.reason).toBe('shop_token_invalid');
  });

  it('⭐ token 错 → 401（签名是真的也不行）', async () => {
    const res = await telnyxCall('/v1/telnyx/tools/lookup_customer',
      { to: AI_LINE, from: '+15125551234', shop_token: 'st_not_the_right_one' });
    expect(res.statusCode).toBe(401);
  });

  it('⭐ 挂机 webhook 不要 token —— 那条路带不了自定义参数，要了电话就不计费了', async () => {
    const res = await telnyxCall('/v1/telnyx/webhook', {
      data: {
        event_type: 'call.hangup',
        payload: {
          call_session_id: `no-token-${randomUUID()}`,
          to: AI_LINE, from: '+15125551234',
          start_time: new Date(Date.now() - 60_000).toISOString(),
          end_time: new Date().toISOString(),
          hangup_cause: 'normal_clearing',
        },
      },
      shop_token: undefined,
    });
    expect(res.statusCode).toBe(200);
  });

  it('库里只有摘要 —— 明文再也拿不出来', async () => {
    const [row] = await withTenant(tenant, (tx) => tx<{ digest: string | null }[]>`
      select tool_token_digest as digest from phone_lines
      where location_id = ${NAIL_LOC} and e164 = ${AI_LINE}`);
    expect(row!.digest).toMatch(/^[0-9a-f]{64}$/);      // SHA-256 hex
    expect(row!.digest).not.toContain(shopToken);
  });

  it('前台改别的设置不会把 token 冲掉 —— 冲掉的表现是电话全哑', async () => {
    // 只是重新保存一次同一条线（比如改转接方式）
    const again = await run<{ toolToken: string | null }>(
      'location.savePhoneLine', { e164: AI_LINE, purpose: 'ai_voice' });
    expect(again.toolToken).toBeNull();                 // 没换新的

    const res = await telnyxCall('/v1/telnyx/tools/list_services', { to: AI_LINE });
    expect(res.statusCode).toBe(200);                   // 旧 token 照样能用
  });

  it('轮换之后旧 token 立刻失效', async () => {
    const rotated = await run<{ toolToken: string | null }>(
      'location.savePhoneLine',
      { e164: AI_LINE, purpose: 'ai_voice', rotateToolToken: true });
    expect(rotated.toolToken).toMatch(/^st_/);
    expect(rotated.toolToken).not.toBe(shopToken);

    const old = await telnyxCall('/v1/telnyx/tools/list_services',
      { to: AI_LINE, shop_token: shopToken });
    expect(old.statusCode).toBe(401);

    // 换成新的，后面的用例照常跑
    shopToken = rotated.toolToken!;
    const now = await telnyxCall('/v1/telnyx/tools/list_services', { to: AI_LINE });
    expect(now.statusCode).toBe(200);
  });
});

describe('tool：接通那一下（start_call）', () => {
  /*
   * 四个只读工具里有三个在一通电话里是**静态的**（客人是谁、卖什么、谁在班），
   * 合并成一次调用省掉两段静默 —— 电话里每一次工具调用都是一秒多的沉默，
   * 客人会以为断线了。
   *
   * ⚠️ 空档**不在其中**，下面第二条就是钉这件事的。
   */
  const start = async (over: Record<string, unknown> = {}) => {
    const res = await telnyxCall('/v1/telnyx/tools/start_call',
      { to: AI_LINE, from: '+15125551234', ...over });
    expect(res.statusCode).toBe(200);
    return res.json();
  };

  it('一次给齐：门店、营业时间、来电客人、价目表、今天谁在班', async () => {
    const body = await start();

    expect(body.shop.locationId).toBe(NAIL_LOC);
    expect(body.businessDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // 「你们周日开吗」是电话里最高频的问题之一，以前 AI 根本答不上来
    expect(body.businessHours.sun ?? body.businessHours.mon).toBeTruthy();
    expect(body.services.length).toBeGreaterThan(0);
    expect(body.services.every((s: { isAddon: boolean }) => !s.isAddon)).toBe(true);
    expect(body.addons.every((s: { isAddon: boolean }) => s.isAddon)).toBe(true);
    expect(body.staff.length).toBeGreaterThan(0);
    expect(body.caller.customers).toBeDefined();
  });

  it('⭐ 里面一个时段都没有 —— 时间只能来自 find_slots', async () => {
    /*
     * 这是这次合并唯一的风险：把空档一起塞进开场那一坨，模型会在
     * 五分钟后照着念一个已经被前台订走的时段。所以宁可多一次调用。
     */
    const body = await start();
    const json = JSON.stringify(body);

    expect(body.slots).toBeUndefined();
    expect(body.alternatives).toBeUndefined();
    expect(json).not.toMatch(/startsAt/);
    // 而且要在 guidance 里明说，别让模型自己悟
    expect(body.guidance).toMatch(/find_slots/);
  });

  it('⭐ 给 AI 的话术全是英文 —— 中文写死在服务端，英文客人那头就只能听它现编', async () => {
    /*
     * 2026-08-23 第一通真实电话之后店主提的：接口里不要中文。
     * `say` 是要 AI **照念**的句子，`guidance` 是给模型的指令 ——
     * 两样都用英文，多语言由模型按客人说的语言翻（instructions 里写了，
     * 确认码/日期/时间原样保留）。
     */
    const body = await start();
    const chinese = /[\u4e00-\u9fff]/;
    expect(body.guidance).not.toMatch(chinese);
    expect(body.caller.guidance ?? '').not.toMatch(chinese);

    for (const [url, payload] of [
      ['/v1/telnyx/tools/find_slots', { to: AI_LINE }],
      ['/v1/telnyx/tools/list_services', { to: AI_LINE }],
      ['/v1/telnyx/tools/list_staff', { to: AI_LINE }],
      ['/v1/telnyx/tools/request_callback',
       { to: AI_LINE, from: '+15125551234', call_session_id: `zh-${randomUUID()}` }],
    ] as const) {
      const j = (await telnyxCall(url, payload)).json();
      expect(j.guidance ?? '', url).not.toMatch(chinese);
      expect(j.say ?? '', url).not.toMatch(chinese);
    }
  });

  it('技师的技能是人话，不是一坨多语言 jsonb', async () => {
    // 不转的话 AI 拿到的是 {"en":"Gel","zh-Hans":"甲油胶"} —— 它会照着念出来
    const body = await start();
    for (const st of body.staff) {
      for (const k of st.skills) expect(typeof k).toBe('string');
    }
  });

  it('同号多客户时，「请问是哪位」那句跟着 caller 一起回来', async () => {
    // 种子里 +19175550188 下面挂着张先生和张女士（决策 21）
    const body = await start({ from: '+19175550188' });
    expect(body.caller.customers.length).toBeGreaterThan(1);
    expect(body.caller.guidance).toMatch(/who is speaking/);
  });

  it('和单独调那三个工具给的是同一份东西', async () => {
    // 合并不是重写：两条路走的是同一份实现，不然迟早各说各的
    const body = await start();
    const svc = (await telnyxCall('/v1/telnyx/tools/list_services', { to: AI_LINE })).json();
    const stf = (await telnyxCall('/v1/telnyx/tools/list_staff', { to: AI_LINE })).json();

    expect(body.services.map((x: { serviceId: string }) => x.serviceId))
      .toEqual(svc.services.map((x: { serviceId: string }) => x.serviceId));
    expect(body.staff.map((x: { membershipId: string }) => x.membershipId))
      .toEqual(stf.therapists.map((x: { membershipId: string }) => x.membershipId));
  });
});

describe('通话记录：计量 / 转录 / 转接（sql/0037）', () => {
  const callId = () => `rec-${randomUUID()}`;

  it('⭐ 转录是另一条命令补的 —— 同一个幂等键会命中缓存，转录就永远写不进去', async () => {
    /*
     * 这是这套设计里最容易做错的一处：挂机 webhook 和对账任务写的是
     * 同一通电话。用同一个幂等键 dispatch `call.record` 的话，第二次
     * **命中缓存直接返回**（处理器根本不执行）；换一个键又会**再扣一次
     * 语音分钟**。所以补料必须是不碰钱的另一条命令。
     */
    const id = callId();
    await runAsPhone('call.record', {
      providerCallId: id, durationSeconds: 90, outcome: 'completed',
    }, `telnyx-hangup-${id}`);

    const out = await runAsPhone<{ updated: boolean }>('call.attachTranscript', {
      providerCallId: id,
      conversationId: `conv-${id}`,
      transcript: [
        { role: 'assistant', text: 'Thanks for calling.' },
        { role: 'user', text: 'Do you have anything Wednesday?' },
        { role: 'tool', text: '{"ok":true}', tool: 'find_slots' },
      ],
      toolsUsed: ['start_call', 'find_slots', 'book_appointment'],
    });
    expect(out.updated).toBe(true);

    const [row] = await withTenant(tenant, (tx) => tx<{
      duration_seconds: number; tools_used: string[]; n: number;
    }[]>`
      select duration_seconds, tools_used,
             jsonb_array_length(coalesce(transcript,'[]'::jsonb)) as n
      from phone_calls where provider_call_id = ${id}`);

    expect(row!.n).toBe(3);
    expect(row!.tools_used).toContain('book_appointment');
    // ⭐ 补料不能把已经记下的时长抹掉 —— 账是按它扣过的
    expect(row!.duration_seconds).toBe(90);
  });

  it('补到一通不存在的电话上 → 什么都不做，不凭空插一行', async () => {
    // 插了就会出现「有转录、没时长、没扣过分钟」的幽灵通话
    const out = await runAsPhone<{ updated: boolean; callId: string | null }>(
      'call.attachTranscript', { providerCallId: `ghost-${randomUUID()}` });
    expect(out.updated).toBe(false);
    expect(out.callId).toBeNull();
  });

  it('⭐ 语音分钟只扣一次 —— 补料这条不碰钱', async () => {
    const id = callId();
    const before = await withTenant(tenant, (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from usage_events
      where location_id = ${NAIL_LOC} and kind = 'ai_call_min'`);

    await runAsPhone('call.record', {
      providerCallId: id, durationSeconds: 120, outcome: 'completed',
    }, `telnyx-hangup-${id}`);
    await runAsPhone('call.attachTranscript', {
      providerCallId: id, transcript: [{ role: 'user', text: 'hi' }],
    });

    const after = await withTenant(tenant, (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from usage_events
      where location_id = ${NAIL_LOC} and kind = 'ai_call_min'`);
    expect(after[0]!.n).toBe(before[0]!.n + 1);
  });

  it('前台读得到转录，但来电号码按 customer.view_contact 脱敏', async () => {
    const id = callId();
    await runAsPhone('call.record', {
      providerCallId: id, fromE164: '+16175551234',
      durationSeconds: 60, outcome: 'completed',
    }, `telnyx-hangup-${id}`);
    await runAsPhone('call.attachTranscript', {
      providerCallId: id,
      transcript: [{ role: 'assistant', text: "You're all set." }],
      toolsUsed: ['book_appointment'],
    });

    const seen = await withTenant(tenant, (tx) => loadCalls(tx, ctx, { days: 1 }));
    const mine = seen.calls.find((c) => c.transcript.some((l) => l.text.includes('all set')));
    expect(mine).toBeTruthy();
    expect(mine!.booked).toBe(true);          // 列表上一眼看得出「真订上了」
    expect(seen.totalMinutes).toBeGreaterThan(0);

    // 店长有 view_contact，看得到完整号码；没有的身份看到的是尾号
    const masked = await withTenant(tenant, (tx) => loadCalls(tx, {
      ...ctx, permissions: new Set(['appointment.read']),
    }, { days: 1 }));
    const m = masked.calls.find((c) => c.callId === mine!.callId);
    expect(m!.fromE164).toBe('••••1234');
  });

  it('⭐ 没配人工客服号时，start_call 明说不能转接', async () => {
    // 说了「我帮您转接」却转不过去，客人听到的是一声忙音，这通电话就没了
    const body = (await telnyxCall('/v1/telnyx/tools/start_call',
      { to: AI_LINE, from: '+15125551234' })).json();
    expect(body.transfer).toBeDefined();
    expect(body.transfer.available).toBe(false);   // 种子店没填 transfer_target
    expect(body.guidance).toMatch(/never say you will transfer/);
  });
});

describe('tool：报项目（加项要分得出来）', () => {
  it('⭐ 加项单独放在 addons 里 —— 混在一起模型会把「热石 $15」当成一次服务卖', async () => {
    const res = await telnyxCall('/v1/telnyx/tools/list_services', { to: AI_LINE });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.services.every((x: { isAddon: boolean }) => !x.isAddon)).toBe(true);
    expect(body.addons.every((x: { isAddon: boolean }) => x.isAddon)).toBe(true);
    // 种子里美甲店有卸甲/彩绘/石蜡三个加项
    expect(body.addons.length).toBeGreaterThan(0);
    expect(body.guidance).toMatch(/ADD-ONS/);
  });
});

describe('tool：查空档（补齐的四个入参）', () => {
  const slotsOf = async (payload: Record<string, unknown>) => {
    const res = await telnyxCall('/v1/telnyx/tools/find_slots', { to: AI_LINE, ...payload });
    expect(res.statusCode).toBe(200);
    return res.json();
  };

  it('⭐ 多项目连做：时长是各项之和，不是模型估的那个数', async () => {
    const main = catalog.find((c) => !c.is_addon)!;
    const addon = catalog.find((c) => c.is_addon)!;

    const body = await slotsOf({
      around: noonAt(DAY_OPEN),
      services: [main.name, addon.name],
      // 模型给了一个错的估计值；库里的时长必须赢
      duration_min: 20,
    });

    expect(body.durationMin).toBe(main.duration_min + addon.duration_min);
    expect(body.services.map((x: { name: string }) => x.name)).toContain(addon.name);
  });

  it('项目名听不出来时照样报时间，但 guidance 会让 AI 先去核对', async () => {
    const body = await slotsOf({
      around: noonAt(DAY_OPEN),
      services: ['那个什么来着，弄脚的那个'],
    });
    expect(body.guidance).toMatch(/not on the service list/);
    expect(body.durationMin).toBe(45);   // 退回默认值，而不是 0 或 NaN
  });

  it('⭐ 只要女技师 → 报出来的每一个人都是女技师', async () => {
    const female = new Set(bookable.filter((b) => b.gender === 'female').map((b) => b.id));
    const male = bookable.filter((b) => b.gender === 'male');
    expect(female.size).toBeGreaterThan(0);
    expect(male.length).toBeGreaterThan(0);   // 种子里得有男技师，否则这条测了个寂寞

    const body = await slotsOf({ around: noonAt(DAY_OPEN), gender_preference: 'female' });
    expect(body.slots.length).toBeGreaterThan(0);
    for (const s of body.slots) {
      for (const p of s.staff) expect(female.has(p.membershipId)).toBe(true);
    }
  });

  it('性别筛选发生在找空档之前 —— 男技师占满 limit 不该把女技师挤掉', async () => {
    // 全店一起找时，前几个时刻的候选里男女都有；只要女技师时
    // 报出来的时刻数量不该因此变少（先算后过滤就会变少）
    const all = await slotsOf({ around: noonAt(DAY_OPEN) });
    const onlyFemale = await slotsOf({ around: noonAt(DAY_OPEN), gender_preference: 'female' });
    expect(onlyFemale.slots.length).toBe(all.slots.length);
  });

  it('⭐ 两位客人一起来 → 每个报出去的时刻都凑得齐两位技师', async () => {
    const body = await slotsOf({ around: noonAt(DAY_OPEN), party_size: 2 });
    expect(body.partySize).toBe(2);
    expect(body.slots.length).toBeGreaterThan(0);
    for (const s of body.slots) expect(s.staff.length).toBeGreaterThanOrEqual(2);
    expect(body.guidance).toMatch(/2 therapists free at once/);
  });

  it('同行人数比在班技师还多 → 明说没有，不硬报一个时间', async () => {
    const body = await slotsOf({ around: noonAt(DAY_OPEN), party_size: bookable.length + 1 });
    expect(body.slots).toEqual([]);
  });

  it('⭐ 那天没空档 → 往后找三天，且 guidance 写明这是改期建议', async () => {
    const body = await slotsOf({ around: noonAt(DAY_SHUT) });

    expect(body.slots).toEqual([]);
    expect(body.alternatives.length).toBeGreaterThan(0);
    expect(body.alternatives.map((a: { businessDate: string }) => a.businessDate))
      .toContain(DAY_LATER);
    // 这句话是这条路的全部意义：不写明的话，客人会照着他要的那天来
    expect(body.guidance).toMatch(/OTHER DAYS/);
    // 改期建议**不能**混进 slots —— 混进去就等于报了一个客人没要的日子
    expect(body.slots).not.toContainEqual(expect.objectContaining({ startsAt: expect.anything() }));
  });
});

describe('tool：真建预约', () => {
  const bookAt = async (payload: Record<string, unknown>) => {
    const res = await telnyxCall('/v1/telnyx/tools/book_appointment', {
      to: AI_LINE, from: '+15125551234', caller_name: '电话测试', ...payload,
    });
    expect(res.statusCode).toBe(200);
    return res.json();
  };

  const firstSlot = async (payload: Record<string, unknown> = {}) => {
    const res = await telnyxCall('/v1/telnyx/tools/find_slots', {
      to: AI_LINE, around: noonAt(DAY_OPEN), ...payload,
    });
    return res.json().slots[0]!.startsAt as string;
  };

  it('⭐ 只听到加项 → 不建单，回一句能直接问出口的话', async () => {
    const addon = catalog.find((c) => c.is_addon)!;
    const body = await bookAt({
      call_session_id: `addon-${randomUUID()}`,
      services: [addon.name],
      slot_starts_at: await firstSlot(),
    });

    expect(body.ok).toBe(false);
    expect(body.missing).toContain('service');
    // 「不好意思，信息不全」在电话里是死路 —— 客人不知道该补什么
    expect(body.say).toMatch(/goes on top of another service/);
  });

  it('⭐ 幂等重放：同一个 call id 不多建单，念的确认码也不变', async () => {
    const callId = `book-${randomUUID()}`;
    const main = catalog.find((c) => !c.is_addon)!;
    const payload = {
      call_session_id: callId, services: [main.name],
      slot_starts_at: await firstSlot(),
    };

    const a = await bookAt(payload);
    const b = await bookAt(payload);

    expect(a.ok).toBe(true);
    expect(b.appointmentId).toBe(a.appointmentId);
    /*
     * 确认码也必须一样。重放时路由会**再生成一个**新码，
     * 直接念它的话：客人手机上的短信写着 GF-HCJR，
     * AI 在电话里念的是 GF-ZRY5 —— 到店报哪个都对不上。
     */
    expect(b.confirmationCode).toBe(a.confirmationCode);
    expect(b.say).toContain(a.confirmationCode.split('').join(' '));
  });

  it('⭐ 两位客人 → 建出两条并排的 item，各占一位技师', async () => {
    const main = catalog.find((c) => !c.is_addon)!;
    const startsAt = await firstSlot({ party_size: 2 });
    const body = await bookAt({
      call_session_id: `party-${randomUUID()}`,
      services: [main.name], party_size: 2, slot_starts_at: startsAt,
    });
    expect(body.ok).toBe(true);

    const items = await withTenant(tenant, (tx) => tx<{ membership_id: string | null }[]>`
      select membership_id from appointment_items
      where appointment_id = ${body.appointmentId}`);
    // 只记 party_size: 2 而底下一条 item 的话，日程表上只占掉一个人 ——
    // 到店来了两位，第二位没有技师
    expect(items).toHaveLength(2);
    expect(new Set(items.map((i) => i.membership_id)).size).toBe(2);
  });

  it('加项挂在主项目上，时长并进去（不是另起一条单）', async () => {
    const main = catalog.find((c) => !c.is_addon)!;
    const addon = catalog.find((c) => c.is_addon)!;
    const body = await bookAt({
      call_session_id: `addon-ok-${randomUUID()}`,
      services: [main.name, addon.name],
      slot_starts_at: await firstSlot({ services: [main.name, addon.name] }),
    });
    expect(body.ok).toBe(true);
    expect(body.durationMin).toBe(main.duration_min + addon.duration_min);

    const items = await withTenant(tenant, (tx) => tx<{
      addon_ids: string[]; duration_min: number;
    }[]>`
      select addon_ids, duration_min from appointment_items
      where appointment_id = ${body.appointmentId}`);
    expect(items).toHaveLength(1);
    expect(items[0]!.addon_ids).toContain(addon.id);
    expect(items[0]!.duration_min).toBe(main.duration_min + addon.duration_min);
  });
});

describe('tool：放进复核队列', () => {
  it('AI 只写草案，一条真预约都建不出来', async () => {
    const before = await withTenant(tenant, (tx) => tx<{ n: string }[]>`
      select count(*) as n from appointments where location_id = ${NAIL_LOC}`);

    const res = await telnyxCall('/v1/telnyx/tools/draft_appointment', {
      to: AI_LINE, from: '+15125551234',
      call_session_id: `test-${randomUUID()}`,
      service_heard: 'gel manicure', time_heard: '明天下午四点',
      caller_name: 'Chen',
    });
    expect(res.statusCode).toBe(200);

    const after = await withTenant(tenant, (tx) => tx<{ n: string }[]>`
      select count(*) as n from appointments where location_id = ${NAIL_LOC}`);
    expect(Number(after[0]!.n)).toBe(Number(before[0]!.n));
    expect((await drafts()).drafts.length).toBeGreaterThan(0);
  });

  it('⭐ AI 能建单，但改不了也取消不了（2026-08-22 决策变更后的边界）', async () => {
    /*
     * 店主 2026-08-22 把决策 6 改成「AI 直接建单」，于是
     * `appointment.write` 进了权限集 —— 这是这条链路上唯一一次扩权。
     * 配套的边界必须钉住：**能建，不能改，不能删**。
     * 建错一单前台看得见、补得回；被静默改掉的单没有人会发现。
     *
     * ⚠️ 入参必须是**形状合法**的：总线是先校验 Zod 再查权限，
     * 传一个缺字段的载荷会先撞上 VALIDATION_FAILED，那就没验到权限这一步 ——
     * 一个看起来通过、其实什么都没证明的测试。
     */
    expect(sysCtx().permissions.has('appointment.write')).toBe(true);
    expect(sysCtx().permissions.has('appointment.cancel')).toBe(false);

    await expect(dispatch('appointment.cancel', {
      appointmentId: randomUUID(), reason: 'guest_changed_mind', keepStaffTurn: false,
    }, sysCtx(), { idempotencyKey: randomUUID() }))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('⭐ AI 编的时间过不了排期引擎 —— 会被清空并标低置信度', async () => {
    // 模型很擅长说出一个听起来合理、但那天店里没人在班的时间。
    // 客人在电话里已经听到了肯定答复，前台看到「16:00」也不会觉得有问题
    const madeUp = new Date(Date.now() + 90 * 24 * 3600_000);  // 三个月后，肯定没排班
    madeUp.setUTCHours(20, 0, 0, 0);

    const res = await telnyxCall('/v1/telnyx/tools/draft_appointment', {
      to: AI_LINE, from: '+15125551234',
      call_session_id: `made-up-${randomUUID()}`,
      service_heard: 'gel manicure',
      slot_starts_at: madeUp.toISOString(), duration_min: 45,
      confidence_bp: 9800,
    });
    expect(res.statusCode).toBe(200);

    const d = (await drafts()).drafts[0]!;
    expect(d.time.slotStartsAt).toBeNull();          // 时间被清掉了
    expect(d.lowConfidence).toBe(true);              // 而且标黄
    expect(d.notes).toMatch(/并不空闲/);              // 前台看得懂为什么
    expect(d.readyToBook).toBe(false);
  });

  it('⭐ 幂等：同一通电话重投两次只进一条待办', async () => {
    // 不去重前台会看到两条一模一样的，而她分不清是客人打了两次还是系统重了
    const callId = `dup-${randomUUID()}`;
    const payload = {
      to: AI_LINE, from: '+15125551234', call_session_id: callId,
      service_heard: 'pedicure',
    };
    const a = await telnyxCall('/v1/telnyx/tools/draft_appointment', payload);
    const b = await telnyxCall('/v1/telnyx/tools/draft_appointment', payload);

    expect(a.json().draftId).toBe(b.json().draftId);
  });

  it('AI 要说的那句话由我们定死，不让模型自己发挥', async () => {
    const res = await telnyxCall('/v1/telnyx/tools/draft_appointment', {
      to: AI_LINE, from: '+15125551234', call_session_id: `say-${randomUUID()}`,
      service_heard: 'manicure',
    });
    // 模型会倾向于说「已经帮您约好了」，而它其实只是放进了待办
    expect(res.json().say).toMatch(/front desk will call you back/);
    expect(res.json().say).not.toMatch(/booked|all set/i);
  });

  it('听不出的项目名留空，但原话一定留着', async () => {
    // 猜一个「最像的」比留空危险：屏幕上会写着一个看起来完全正常的项目名
    await telnyxCall('/v1/telnyx/tools/draft_appointment', {
      to: AI_LINE, from: '+15125551234', call_session_id: `unk-${randomUUID()}`,
      service_heard: '那个什么来着，弄脚的那个',
    });
    const d = (await drafts()).drafts[0]!;
    expect(d.service.matchedId).toBeNull();
    expect(d.service.heard).toBe('那个什么来着，弄脚的那个');
  });
});

describe('复核', () => {
  it('忽略必须给原因 —— 否则「AI 准不准」永远说不清', async () => {
    await telnyxCall('/v1/telnyx/tools/draft_appointment', {
      to: AI_LINE, from: '+15125551234', call_session_id: `dis-${randomUUID()}`,
      service_heard: 'manicure',
    });
    const d = (await drafts()).drafts[0]!;

    await expect(run('call.reviewDraft', { draftId: d.draftId, decision: 'dismissed' }))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    await run('call.reviewDraft', {
      draftId: d.draftId, decision: 'dismissed', dismissReason: 'not_a_booking',
    });
    expect((await drafts('dismissed')).drafts.some((x) => x.draftId === d.draftId)).toBe(true);
  });

  it('复核过的不能再复核一次', async () => {
    const dismissed = (await drafts('dismissed')).drafts[0]!;
    await expect(run('call.reviewDraft', {
      draftId: dismissed.draftId, decision: 'confirmed',
    })).rejects.toMatchObject({ code: 'ALREADY_CANCELLED' });
  });

  it('三要素缺哪个就明说缺哪个 —— 灰掉按钮不说原因，前台只会以为系统坏了', async () => {
    await telnyxCall('/v1/telnyx/tools/draft_appointment', {
      to: AI_LINE, from: '+19995550000', call_session_id: `miss-${randomUUID()}`,
      service_heard: 'unknown thing',
    });
    const d = (await drafts()).drafts[0]!;
    expect(d.readyToBook).toBe(false);
    expect(d.missing).toContain('项目');
    expect(d.missing).toContain('时间');
  });
});

describe('店家的两个号码（09 §2 接入方式）', () => {
  const STOREFRONT = '+15125550001';
  const HUMAN_DESK = '+15125550002';

  it('存下两个号，并告诉前端还没开通', async () => {
    const out = await run<{ aiVoiceE164: string | null; storefrontE164: string }>(
      'location.requestAiVoice',
      { storefrontE164: STOREFRONT, transferTargetE164: HUMAN_DESK });

    expect(out.storefrontE164).toBe(STOREFRONT);
    // 这家店的 ai_voice 是 beforeAll 里绑好的，所以这里拿得到
    expect(out.aiVoiceE164).toBe(AI_LINE);

    const rows = await withTenant(tenant, (tx) => tx<{ purpose: string; e164: string }[]>`
      select purpose, e164 from phone_lines
      where location_id = ${NAIL_LOC} and purpose in ('main','transfer_target')
      order by purpose`);
    expect(rows.map((r) => r.purpose)).toEqual(['main', 'transfer_target']);
  });

  it('⭐ 两个号相同 + 只在没人接时转 → 允许（店里就一部电话是常态）', async () => {
    const out = await run<{ transferTargetE164: string }>('location.requestAiVoice', {
      storefrontE164: STOREFRONT, transferTargetE164: STOREFRONT,
      forwardingMode: 'busy_no_answer',
    });
    // 转人工＝打回店里，有人闲下来就接得到。只有还是没人接才会再听一遍 AI
    expect(out.transferTargetE164).toBe(STOREFRONT);
  });

  it('⭐ 两个号相同 + 全部转给 AI → 拒绝（人永远接不到）', async () => {
    // 转人工 → 打回对外号 → 那个号无条件又转给 AI → 转人工 → ……
    // 和上一条的区别：这个环**必然**发生，不像「无应答才转」
    // 至少给了店里一次接起来的机会
    await expect(run('location.requestAiVoice', {
      storefrontE164: STOREFRONT, transferTargetE164: STOREFRONT,
      forwardingMode: 'all',
    })).rejects.toThrow();
  });

  it('转接方式存下来了 —— 校验和话术都靠它', async () => {
    await run('location.requestAiVoice', {
      storefrontE164: STOREFRONT, transferTargetE164: HUMAN_DESK,
      forwardingMode: 'all',
    });
    const [row] = await withTenant(tenant, (tx) => tx<{ forwarding_mode: string }[]>`
      select forwarding_mode from phone_lines
      where location_id = ${NAIL_LOC} and purpose = 'main' and active`);
    expect(row!.forwarding_mode).toBe('all');
  });

  it('⭐ 不许把我们的落地号填进去 —— 那是 AI 转给 AI', async () => {
    // 客人会听见同一句开场白第二遍，而前台永远等不到那通电话
    await expect(run('location.requestAiVoice',
      { storefrontE164: STOREFRONT, transferTargetE164: AI_LINE }))
      .rejects.toThrow();
  });

  it('⭐ 同一个手机号可以在两家店都当人工客服号', async () => {
    // 这正是把 e164 唯一约束收窄到「会被反查的 purpose」的理由（sql/0025）：
    // 人工客服号常常是老板的手机，而一个老板开两三家店在这行很普遍。
    // 全局唯一的话，第二家店会撞一个看起来毫无道理的约束错误。
    const [other] = await withTenant(tenant, (tx) => tx<{ id: string }[]>`
      select id from locations where id <> ${NAIL_LOC} and org_id = ${NAIL_ORG} limit 1`);
    if (!other) return;   // 种子数据只有一家店时跳过

    const otherCtx = { ...ctx, locationId: other.id };
    await dispatch('location.requestAiVoice',
      { storefrontE164: '+15125550003', transferTargetE164: HUMAN_DESK },
      otherCtx, { idempotencyKey: randomUUID() });

    const rows = await withTenant({ ...tenant, locationId: other.id },
      (tx) => tx<{ n: number }[]>`
        select count(*)::int as n from phone_lines
        where e164 = ${HUMAN_DESK} and purpose = 'transfer_target'`);
    expect(rows[0]!.n).toBe(2);

    await withTenant({ ...tenant, locationId: other.id }, (tx) =>
      tx`delete from phone_lines where location_id = ${other.id}`);
  });
});

describe('通话计费', () => {
  it('分钟数向上取整，落进 ai_call_min（与 ai_assist 分开，决策 8）', async () => {
    const callId = `bill-${randomUUID()}`;
    const out = await runAsPhone<{ billedMinutes: number }>('call.record', {
      providerCallId: callId, durationSeconds: 95, outcome: 'completed',
    }, `rec-${callId}`);

    expect(out.billedMinutes).toBe(2);   // 95 秒 = 2 分钟

    const [ev] = await withTenant(tenant, (tx) => tx<{ kind: string; qty: number }[]>`
      select kind, qty from usage_events
      where location_id = ${NAIL_LOC} and meta->>'providerCallId' = ${callId}`);
    expect(ev!.kind).toBe('ai_call_min');
    expect(ev!.qty).toBe(2);
  });

  it('⭐ webhook 重投不会把分钟数记两遍 —— 那是直接给客户多收钱', async () => {
    const callId = `dup-bill-${randomUUID()}`;
    const key = `rec-${callId}`;
    await runAsPhone('call.record', { providerCallId: callId, durationSeconds: 120 }, key);
    await runAsPhone('call.record', { providerCallId: callId, durationSeconds: 120 }, key);

    const evs = await withTenant(tenant, (tx) => tx<{ qty: number }[]>`
      select qty from usage_events
      where location_id = ${NAIL_LOC} and meta->>'providerCallId' = ${callId}`);
    expect(evs).toHaveLength(1);
  });

  /** 单价从环境读，所以这两条自己设/还原，不依赖跑测试时的 .env */
  async function recordWithRate(rate: string | undefined, durationSeconds: number) {
    const prev = process.env['TELNYX_RATE_PER_MIN_MILLICENTS'];
    if (rate === undefined) delete process.env['TELNYX_RATE_PER_MIN_MILLICENTS'];
    else process.env['TELNYX_RATE_PER_MIN_MILLICENTS'] = rate;
    const callId = `rate-${randomUUID()}`;
    try {
      await runAsPhone('call.record', {
        providerCallId: callId, durationSeconds, outcome: 'completed',
      }, `rec-${callId}`);
    } finally {
      if (prev === undefined) delete process.env['TELNYX_RATE_PER_MIN_MILLICENTS'];
      else process.env['TELNYX_RATE_PER_MIN_MILLICENTS'] = prev;
    }
    const [ev] = await withTenant(tenant, (tx) => tx<{
      cost_cents: number; meta: Record<string, unknown>;
    }[]>`
      select cost_cents, meta from usage_events
      where location_id = ${NAIL_LOC} and meta->>'providerCallId' = ${callId}`);
    return ev!;
  }

  it('单价配好之后，cost_cents 按毫分折算（口径与 ai_assist 一致）', async () => {
    const ev = await recordWithRate('6200', 150);
    // 150 秒 → 3 分钟 × 6200 毫分 = 18600 毫分 = 18.6 分 → 19 分
    expect(ev.meta['costMillicents']).toBe(18600);
    expect(ev.cost_cents).toBe(19);
    expect(ev.meta['unitPricePending']).toBeUndefined();
  });

  it('⭐ 把当时用的单价一起记下来 —— 否则事后无法重算历史毛利', async () => {
    // 单价会变（Telnyx 调价 / 换套餐 / 换供应商）。不记的话，
    // 一行 19 分的账既可能是 6200×3 也可能是别的组合，谁也说不清。
    const ev = await recordWithRate('6200', 60);
    expect(ev.meta['ratePerMinMillicents']).toBe(6200);
  });

  it('单价没配时记 0 + unitPricePending，而不是一个估算值', async () => {
    // 填成估算值更糟：那会被当成真数字拿去算单位经济（09 §6）
    const ev = await recordWithRate(undefined, 60);
    expect(ev.cost_cents).toBe(0);
    expect(ev.meta['unitPricePending']).toBe(true);
  });
});

// ═════════════════════════════════ AI 改期 / 取消（批 3）══════════════════

describe('AI 电话改期与取消', () => {
  const CALLER = '+16175559911';

  /** 造一单：客人 + 未来的预约。返回 appointmentId */
  let apptSeq = 0;
  async function makeAppt(
    startsAt: string, phone = CALLER, source: 'phone_ai' | 'desk' = 'phone_ai',
  ): Promise<string> {
    /*
     * ⚠️ 名字要每次不同：`customers_no_exact_dup` 挡的正是
     * 「同号同名重复建客户」（宪法第 16 条的另一半）。
     * 这几条用例要的是「同一个号码名下有两个单」，而那在真实场景里
     * 也是同一个客户 —— 但为了让 insert 过得去，这里各建各的。
     */
    const [cust] = await withTenant(tenant, (tx) => tx<{ id: string }[]>`
      insert into customers (org_id, primary_location_id, display_name, phone_e164)
      values (${NAIL_ORG}, ${NAIL_LOC}, ${`AI 改期测试 ${++apptSeq}`}, ${phone})
      returning id`);
    const out = await run<{ appointmentId: string }>('appointment.create', {
      customerId: cust!.id,
      items: [{ serviceId: catalog[0]!.id, addonIds: [], membershipId: null,
                startsAt, details: {} }],
      partySize: 1, source,
    });
    return out.appointmentId;
  }

  const setPolicy = (over: Record<string, unknown> = {}) =>
    run('location.saveAiChangePolicy', {
      enabled: true, allowReschedule: true, allowCancel: true,
      requireExactCaller: true, requireSingleUpcoming: true,
      minHoursAhead: 24, blockGroup: true, blockSameDay: true, ...over,
    });

  afterEach(async () => {
    /*
     * 每条用例自己收拾。**顺序不能反**：
     * call_drafts.target_appointment_id → appointments → customers，
     * 每一层都指着下一层。反过来第一条 delete 就会撞外键，
     * 而撞了之后残留的单会让下一条用例的「名下只有一单」失真 ——
     * 表现是一串莫名其妙的 multiple_upcoming。
     */
    await withTenant(tenant, (tx) => tx`
      delete from call_drafts cd using appointments a, customers c
      where cd.target_appointment_id = a.id and a.customer_id = c.id
        and a.location_id = ${NAIL_LOC} and c.display_name::text like '%AI 改期测试%'`);
    await withTenant(tenant, (tx) => tx`
      delete from appointments a using customers c
      where a.customer_id = c.id and a.location_id = ${NAIL_LOC}
        and c.display_name::text like '%AI 改期测试%'`);
    await withTenant(tenant, (tx) => tx`
      delete from customers where org_id = ${NAIL_ORG}
        and display_name::text like '%AI 改期测试%'`);
  });

  it('⭐ 默认 enabled=false —— 没配过的店，AI 一律只能提请求', async () => {
    await run('location.saveAiChangePolicy', {
      enabled: false, allowReschedule: true, allowCancel: true,
      requireExactCaller: true, requireSingleUpcoming: true,
      minHoursAhead: 0, blockGroup: false, blockSameDay: false,
    });
    const id = await makeAppt(noonAt(DAY_LATER));

    const res = await telnyxCall('/v1/telnyx/tools/cancel_appointment',
      { to: AI_LINE, from: CALLER, appointment_id: id });
    const body = res.json();
    expect(body.applied).toBe(false);
    expect(body.gateReason).toBe('disabled');

    // ⭐ 那一单必须还在
    const [row] = await withTenant(tenant, (tx) => tx<{ status: string }[]>`
      select status from appointments where id = ${id}`);
    expect(row!.status).not.toBe('cancelled');
  });

  it('⭐ 闸门全过 → AI 真的取消掉', async () => {
    await setPolicy();
    const id = await makeAppt(noonAt(DAY_LATER));

    const res = await telnyxCall('/v1/telnyx/tools/cancel_appointment',
      { to: AI_LINE, from: CALLER, appointment_id: id });
    expect(res.json().applied).toBe(true);

    const [row] = await withTenant(tenant, (tx) => tx<{ status: string }[]>`
      select status from appointments where id = ${id}`);
    expect(row!.status).toBe('cancelled');
  });

  it('⭐ 号码对不上 → 落队列，绝不动那一单', async () => {
    await setPolicy();
    const id = await makeAppt(noonAt(DAY_LATER));

    const res = await telnyxCall('/v1/telnyx/tools/cancel_appointment',
      { to: AI_LINE, from: '+16175550000', appointment_id: id });
    const body = res.json();
    expect(body.applied).toBe(false);
    // 号码不属于任何一单 → 连 upcoming 都查不到，报 not_found 而不是 caller_mismatch
    expect(['caller_mismatch', 'not_found']).toContain(body.gateReason);

    const [row] = await withTenant(tenant, (tx) => tx<{ status: string }[]>`
      select status from appointments where id = ${id}`);
    expect(row!.status).not.toBe('cancelled');
  });

  it('⭐ 名下两个单 → 必落队列，不许替他挑一个', async () => {
    await setPolicy();
    const a = await makeAppt(noonAt(DAY_LATER));
    await makeAppt(new Date(new Date(noonAt(DAY_LATER)).getTime() + 3 * 3600_000).toISOString());

    const res = await telnyxCall('/v1/telnyx/tools/cancel_appointment',
      { to: AI_LINE, from: CALLER, appointment_id: a });
    expect(res.json().applied).toBe(false);
    expect(res.json().gateReason).toBe('multiple_upcoming');
  });

  it('⭐ 老板允许改期但不允许取消 —— 两个开关分别生效', async () => {
    await setPolicy({ allowCancel: false, allowReschedule: true });
    const id = await makeAppt(noonAt(DAY_LATER));

    const no = await telnyxCall('/v1/telnyx/tools/cancel_appointment',
      { to: AI_LINE, from: CALLER, appointment_id: id });
    expect(no.json().applied).toBe(false);
    expect(no.json().gateReason).toBe('not_allowed');

    const yes = await telnyxCall('/v1/telnyx/tools/reschedule_appointment', {
      to: AI_LINE, from: CALLER, appointment_id: id,
      slot_starts_at: new Date(new Date(noonAt(DAY_LATER)).getTime() + 2 * 3600_000).toISOString(),
    });
    expect(yes.json().applied).toBe(true);
  });

  it('⭐ 提前小时数不够 → 落队列（阈值是老板设的，不是写死的）', async () => {
    /*
     * ⚠️ 用一个**两小时后**的单，不是三周后那个。
     * 阈值上限是 168 小时（7 天），而 DAY_LATER 在 23 天之后 ——
     * 拿它去试 minHoursAhead 永远够，测不出这道闸。
     */
    /*
     * ⚠️ 这一单**只能挂在 `desk` 名下**（0046 之后）。
     *
     * 「两小时后」是相对本机时钟算的，跑测试的时间一晚就落到打烊之后，
     * 而营业时间闸门对 `phone_ai` 这条渠道是不给宽限、不给放行的 ——
     * AI 本来就不该在电话里把客人排到关门以后。
     * 这里要测的是 `minHoursAhead` 那道闸，不是建单，所以让前台来建。
     */
    await setPolicy({ minHoursAhead: 24, blockSameDay: false });
    const id = await makeAppt(
      new Date(Date.now() + 2 * 3600_000).toISOString(), CALLER, 'desk');

    const res = await telnyxCall('/v1/telnyx/tools/cancel_appointment',
      { to: AI_LINE, from: CALLER, appointment_id: id });
    expect(res.json().applied).toBe(false);
    expect(res.json().gateReason).toBe('too_soon');

    // 把阈值放宽到 1 小时，同一单就放行了 —— 证明拦下它的确实是这个数
    await setPolicy({ minHoursAhead: 1, blockSameDay: false });
    const ok = await telnyxCall('/v1/telnyx/tools/cancel_appointment',
      { to: AI_LINE, from: CALLER, appointment_id: id });
    expect(ok.json().applied).toBe(true);
  });

  it('find_my_appointment：名下多于一单时 guidance 要求 AI 先问', async () => {
    await makeAppt(noonAt(DAY_LATER));
    await makeAppt(new Date(new Date(noonAt(DAY_LATER)).getTime() + 3 * 3600_000).toISOString());

    const res = await telnyxCall('/v1/telnyx/tools/find_my_appointment',
      { to: AI_LINE, from: CALLER });
    expect(res.json().appointments).toHaveLength(2);
    expect(res.json().guidance).toMatch(/ask which one/i);
  });

  it('落队列的那条带着 kind 和 gate_reason，前台看得出是哪条闸拦的', async () => {
    await setPolicy({ enabled: false });
    const id = await makeAppt(noonAt(DAY_LATER));
    await telnyxCall('/v1/telnyx/tools/cancel_appointment',
      { to: AI_LINE, from: CALLER, appointment_id: id, call_session_id: randomUUID() });

    const [row] = await withTenant(tenant, (tx) => tx<{
      kind: string; gate_reason: string | null; target_appointment_id: string | null;
    }[]>`
      select kind, gate_reason, target_appointment_id from call_drafts
      where location_id = ${NAIL_LOC} and target_appointment_id = ${id}`);
    expect(row!.kind).toBe('cancel');
    expect(row!.gate_reason).toBe('disabled');
  });
});

describe('开场白可配（批 3）', () => {
  it('老板没配 → 用系统默认，mode 是 default', async () => {
    const res = await telnyxCall('/v1/telnyx/tools/start_call', { to: AI_LINE, from: '+15125551234' });
    const g = res.json().greeting;
    expect(g.mode).toBe('default');
    expect(g.text).toMatch(/Thank you for calling/);
  });

  it('⭐ 配了逐字稿 → mode=verbatim，变量被替换掉', async () => {
    await run('location.savePhoneLine', {
      e164: AI_LINE, purpose: 'ai_voice',
      assistantName: 'Emily',
      greetingTemplate: 'Hi, {{store_name}} here. {{assistant_name}} speaking.',
    });
    const res = await telnyxCall('/v1/telnyx/tools/start_call', { to: AI_LINE, from: '+15125551234' });
    const g = res.json().greeting;
    expect(g.mode).toBe('verbatim');
    expect(g.text).toContain('Emily speaking');
    expect(g.text).not.toContain('{{');
  });

  it('⭐ 开了 AI 生成 → mode=generate，text 变成语气参考', async () => {
    await run('location.savePhoneLine', {
      e164: AI_LINE, purpose: 'ai_voice',
      greetingAiGenerated: true,
    });
    expect((await telnyxCall('/v1/telnyx/tools/start_call',
      { to: AI_LINE, from: '+15125551234' })).json().greeting.mode).toBe('generate');
  });

  it('⭐ 改转接方式不该把开场白清空 —— 没传就不动', async () => {
    await run('location.savePhoneLine', {
      e164: AI_LINE, purpose: 'ai_voice', assistantName: 'Emily',
      greetingTemplate: 'Keep me.', greetingAiGenerated: false,
    });
    // 只改一个无关字段
    await run('location.savePhoneLine', { e164: AI_LINE, purpose: 'ai_voice' });

    const g = (await telnyxCall('/v1/telnyx/tools/start_call',
      { to: AI_LINE, from: '+15125551234' })).json().greeting;
    expect(g.text).toBe('Keep me.');
    expect(g.assistantName).toBe('Emily');
  });

  it('显式传 null 才是清空', async () => {
    await run('location.savePhoneLine', {
      e164: AI_LINE, purpose: 'ai_voice', greetingTemplate: 'Bye.', assistantName: 'Emily',
    });
    await run('location.savePhoneLine', {
      e164: AI_LINE, purpose: 'ai_voice', greetingTemplate: null, assistantName: null,
    });
    const g = (await telnyxCall('/v1/telnyx/tools/start_call',
      { to: AI_LINE, from: '+15125551234' })).json().greeting;
    expect(g.mode).toBe('default');
    expect(g.assistantName).toBeNull();
  });
});
