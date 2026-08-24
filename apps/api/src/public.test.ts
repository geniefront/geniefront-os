/**
 * 公开预约 API（docs/13）。
 *
 * 这一份里几乎每个用例都在问同一个问题：
 * **一个陌生人，只拿着官网上那串公开 key，能干什么？**
 *
 *   · 能不能订到老板没勾「可在线预约」的项目（不能）
 *   · 能不能超卖 / 传 override 放行（不能，公开入口没有这条路）
 *   · 能不能拿别人的预约 id 取消掉（不能，要令牌）
 *   · 能不能从别人的网站上调（不能，域名白名单）
 *   · 手抖点两下确认会不会建出两条单（不会，幂等键）
 *   · 蜜罐命中时对方能不能看出来（不能，返回一个长得一样的假 201）
 *   · 同一个手机号能不能把周六全占了（不能，未来未完成预约上限）
 *
 * ⚠️ Turnstile 用测试替身，不打网络。真实的 siteverify 只在
 * `docs/13 §9` 的联调里走一次 —— 那一段只有真发一次才算数。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { withTenant, closeDb } from '@gf/db';
import { businessDateOf, wallMinuteToInstant } from '@gf/scheduling';
import { buildContext } from './actor';
import { dispatch } from './bus';
import { buildServer } from './server';
import { __setTurnstileVerifierForTests } from './public/turnstile';
import { __resetRateLimit } from './public/rateLimit';
import { normalizeOrigin, originAllowed, isHostedBookingOrigin } from './public/origin';
import { generateConfirmationCode, generateManageToken, hashManageToken } from './public/bookingToken';
import './handlers/setup';
import './handlers/shift';

const NAIL_ORG = '11111111-1111-4111-8111-111111111111';
const NAIL_LOC = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const tenant = { orgId: NAIL_ORG, locationId: NAIL_LOC, membershipId: null };
const SITE = 'https://lotus-test.example.com';

let ctx: Awaited<ReturnType<typeof buildContext>>;
let app: ReturnType<typeof buildServer>;
let publicKey = '';
let serviceId = '';
let hiddenServiceId = '';
/** 一个加项（`is_addon`）。能挂在 addonIds 上，但不能单独当主项目 */
let addonId: string | null = null;
let staffId = '';
let originId = '';
/** 排了班的那几天。用例之间不许抢同一格，否则第二个会撞上容量上限 */
let bookDate = '';
let shopTz = '';

/**
 * 发一个**没人用过**的时刻。
 *
 * 一开始所有用例共用同一个 11:00，第二条起全部 409 —— 那其实是系统
 * 在正确工作（同一个技师同一时刻只有一格），但它把十个用例一起拖红了。
 * 每天发五格、连发七天，够这一份用。
 */
let slotSeq = 0;
const PER_DAY = 5;
const DAYS = 14;
function nextSlot(): string {
  const i = slotSeq++;
  if (i >= PER_DAY * DAYS) throw new Error('测试用的空档发完了 —— 调大 DAYS');
  const day = addDays(bookDate, Math.floor(i / PER_DAY));
  const minute = 10 * 60 + (i % PER_DAY) * 90;   // 10:00 / 11:30 / 13:00 / 14:30 / 16:00
  return wallMinuteToInstant(day, shopTz, minute).toISOString();
}

/** 每个用例自己一个 Turnstile 结果，免得互相影响 */
let turnstileOk = true;
const usedTokens = new Set<string>();

async function run<T>(name: string, input: unknown, key?: string): Promise<T> {
  const out = await dispatch<T>(name, input, ctx, key ? { idempotencyKey: key } : {});
  return out.result;
}

/**
 * `app.inject()` 的返回类型是个联合（带回调那个重载），await 之后 TS 认不出
 * `.statusCode`。这一份里用到的就这几样，显式写出来最省事。
 */
interface Injected {
  statusCode: number;
  headers: Record<string, string | string[] | number | undefined>;
  body: string;
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  json: <T = Record<string, any>>() => T;
}

function post(url: string, body: object, headers: Record<string, string> = {}): Promise<Injected> {
  return app.inject({
    method: 'POST', url, payload: body,
    headers: { 'x-gf-public-key': publicKey, origin: SITE, ...headers },
  }) as unknown as Promise<Injected>;
}

function get(url: string, headers: Record<string, string> = {}): Promise<Injected> {
  return app.inject({
    method: 'GET', url,
    headers: { 'x-gf-public-key': publicKey, origin: SITE, ...headers },
  }) as unknown as Promise<Injected>;
}

/** 一份能过校验的建单 body。用例只改自己关心的那一两个字段 */
function bookingPayload(over: Record<string, unknown> = {}) {
  return {
    turnstileToken: `tk_${randomUUID()}`,
    locale: 'en',
    customer: { name: 'Amy Chen', phone: `+1617555${String(Math.floor(Math.random() * 9000) + 1000)}`, smsOptIn: false },
    items: [{ serviceId, addonIds: [], staffId: null, startsAt: nextSlot() }],
    partySize: 1,
    website: '',
    formElapsedMs: 45_000,
    ...over,
  };
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  __setTurnstileVerifierForTests(async ({ token }) => {
    // 同一个 token 用第二次一律失败 —— Cloudflare 就是这个行为，
    // 而「重试时忘了 reset widget」是官网那边最容易犯的错
    if (usedTokens.has(token)) return false;
    usedTokens.add(token);
    return turnstileOk;
  });

  const [m] = await withTenant(tenant, (tx) => tx<{ id: string; user_id: string }[]>`
    select m.id, m.user_id from memberships m
    join membership_roles mr on mr.membership_id = m.id
    join roles r on r.id = mr.role_id
    where m.location_id = ${NAIL_LOC} and m.status = 'active'
      and r.key in ('owner','manager') limit 1`);
  ctx = await buildContext({ userId: m!.user_id, membershipId: m!.id });

  const shop = await withTenant(tenant, (tx) => tx<{
    public_key: string; tz: string; cutoff: string;
  }[]>`
    select public_key, timezone as tz, business_day_cutoff::text as cutoff
    from locations where id = ${NAIL_LOC}`);
  publicKey = shop[0]!.public_key;

  // ── 两个项目：一个开放在线预约，一个老板故意没勾 ───────────────────────
  const svcs = await withTenant(tenant, (tx) => tx<{ id: string }[]>`
    select id from services where location_id = ${NAIL_LOC} and active = true
    order by sort, id limit 2`);
  serviceId = svcs[0]!.id;
  hiddenServiceId = svcs[1]!.id;

  /*
   * ⭐ 再挑一个**加项**（`is_addon`，sql/0035）也打开在线预约。
   *
   * 加项必须是能提交的（它要挂在 `addonIds` 上），但**不能单独当主项目** ——
   * 这两件事得分别测，所以这里刻意让它和主项目一样「勾了在线预约」，
   * 免得测出来的其实是「没勾所以订不了」。
   */
  const addons = await withTenant(tenant, (tx) => tx<{ id: string }[]>`
    select id from services
    where location_id = ${NAIL_LOC} and active = true and is_addon = true
    order by sort, id limit 1`);
  addonId = addons[0]?.id ?? null;

  await withTenant(tenant, (tx) => tx`
    update services set online_bookable = (id = ${serviceId} or id = ${addonId})
    where location_id = ${NAIL_LOC}`);

  // ── 明天排一个班，否则一个空档都算不出来 ────────────────────────────────
  const staff = await withTenant(tenant, (tx) => tx<{ membership_id: string }[]>`
    select sp.membership_id from staff_profiles sp
    join memberships m on m.id = sp.membership_id and m.status = 'active'
    where sp.location_id = ${NAIL_LOC} and sp.is_bookable = true order by sp.membership_id`);
  staffId = staff[0]!.membership_id;

  shopTz = shop[0]!.tz;
  const today = businessDateOf(new Date(), shopTz, shop[0]!.cutoff);
  bookDate = addDays(today, 2);

  /**
   * ⚠️ 把上一次跑留下的 web 单清掉。
   *
   * 测试打的是一个**共享的**开发库。不清的话第二次跑会撞上第一次自己
   * 建的那些单（同一格已经被占 → 409），表现是「代码没改，测试自己红了」——
   * 这种红最费时间，因为第一反应总是去查代码。
   *
   * 只删 `source='web'` 且在测试窗口里的，碰不到任何手工建的数据。
   */
  await withTenant(tenant, (tx) => tx`
    delete from appointments
    where location_id = ${NAIL_LOC} and source = 'web'
      and business_date >= ${bookDate}`);
  /**
   * ⚠️ 班表是**夹具**，用一条批量 SQL 灌，不是 84 次 `shift.set`。
   *
   * 原先是 14 天 × 5 个技师逐条走命令总线 —— 每条一个完整事务、
   * 一次跨区往返，加起来正好卡在 30 秒的 hookTimeout 上：
   * 库稍微慢一点整份就红，而红的地方是 `beforeAll` 超时，
   * 完全看不出和班表有关。
   *
   * 排班命令本身有自己的测试（`shift.*`），这里要的只是「那几天有人上班」
   * 这个前提。夹具走直接写库是可以的 —— 宪法第 1 条管的是**产品代码**。
   */
  const days = Array.from({ length: DAYS }, (_, d) => addDays(bookDate, d));
  await withTenant(tenant, async (tx) => {
    for (const s of staff) {
      await tx`
        insert into shifts (org_id, location_id, membership_id, business_date,
                            start_min, end_min, status)
        select ${NAIL_ORG}, ${NAIL_LOC}, ${s.membership_id}, d::date, 540, 1140, 'published'
        from unnest(${days}::date[]) as d
        on conflict (location_id, membership_id, business_date)
        do update set status = 'published', start_min = 540, end_min = 1140`;
    }
  });

  // ── 打开在线预约 + 白名单 ────────────────────────────────────────────────
  await run('location.saveOnlineBooking', {
    enabled: true, maxDaysAhead: 60, minMinutesAhead: 120,
    requirePhoneVerification: false, cancelCutoffHours: 4,
  });
  const added = await run<{ id: string }>('location.addWebOrigin', { origin: SITE });
  originId = added.id;

  app = buildServer();
  await app.ready();
});

afterAll(async () => {
  /**
   * ⭐ 把自己造出来的数据收干净。
   *
   * 这些用例每跑一次就往共享的开发库里加几十个客户 ——
   * `packages/db/src/rls.test.ts` 那条「顾客数据不跨 org 泄露」
   * 原先是数条数的，被这几十个直接顶红了。那条测试已经改成不数条数，
   * 但**测试自己收拾干净**仍然是底线：留下来的垃圾早晚会绊倒别人。
   *
   * ⚠️ 顺序不能反：预约指着客户（外键）。
   */
  /**
   * ⚠️ **不要删 sms_outbox。**
   *
   * `sql/0034` 对 app_user `revoke delete` —— 发过什么是「我们对客人说过什么」
   * 的凭据。这里删一下会抛 permission denied，**而它和下面两条删除在同一个
   * 事务里**：整个清理回滚，预约和客户全留下来，
   * 而外面那个 `.catch(() => null)` 把错误吃掉了 —— 清理就这么静默停摆了。
   * （2026-08-22 真踩过：库里堆了四十多条测试预约才发现。）
   *
   * 那几行 outbox 就让它留着：测试里 `sendSms` 是假的（NODE_ENV=test），
   * 一条都没真发出去，留下的只是几行记录。
   */
  await withTenant(tenant, async (tx) => {
    await tx`delete from appointments
             where location_id = ${NAIL_LOC} and source = 'web'
               and business_date >= ${bookDate}`;
    await tx`delete from customers
             where org_id = ${NAIL_ORG} and source = 'web'
               and not exists (select 1 from appointments a where a.customer_id = customers.id)`;
  }).catch(() => null);

  await run('location.removeWebOrigin', { id: originId }).catch(() => null);
  await run('location.saveOnlineBooking', {
    enabled: false, maxDaysAhead: 60, minMinutesAhead: 120,
    requirePhoneVerification: false, cancelCutoffHours: 4,
  }).catch(() => null);
  __setTurnstileVerifierForTests(null);
  await app?.close();
  await closeDb();
});

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ─────────────────────────────────────────────────────────────── 纯函数

describe('域名规范化', () => {
  it('老板粘什么进来都收敛成 协议://主机', () => {
    expect(normalizeOrigin('lotusnails.com')).toBe('https://lotusnails.com');
    expect(normalizeOrigin('https://Lotusnails.com/booking?x=1')).toBe('https://lotusnails.com');
    expect(normalizeOrigin('  https://shop.lotusnails.com:8443/  ')).toBe('https://shop.lotusnails.com:8443');
  });

  it('⭐ 非 localhost 的 http 一律拒绝', () => {
    expect(normalizeOrigin('http://lotusnails.com')).toBeNull();
    expect(normalizeOrigin('http://localhost:5173')).toBe('http://localhost:5173');
  });

  it('通配只吃一层子域', () => {
    const list = ['https://*.pages.dev'];
    expect(originAllowed('https://abc.pages.dev', list)).toBe(true);
    expect(originAllowed('https://evil.abc.pages.dev', list)).toBe(false);
    expect(originAllowed('https://pages.dev', list)).toBe(false);
  });

  it('⭐ 我们自己托管的那张预约页永远放行 —— 老板没理由填别人的域名', () => {
    // apps/booking 跑在我们的域名下。嵌进老板官网的 iframe 里时，
    // 文档 origin 还是 book.geniefront.com，不是 lotusnails.com
    expect(isHostedBookingOrigin('https://book.geniefront.com')).toBe(true);
    expect(isHostedBookingOrigin('http://localhost:5176')).toBe(true);
    expect(isHostedBookingOrigin('http://127.0.0.1:5176')).toBe(true);

    expect(isHostedBookingOrigin('https://evil.example.com')).toBe(false);
    expect(isHostedBookingOrigin('https://book.geniefront.com.evil.com')).toBe(false);
    expect(isHostedBookingOrigin(undefined)).toBe(false);
  });

  it('确认码里没有会念错的 I O 0 1', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateConfirmationCode('Lotus Nails');
      expect(code).toMatch(/^LO-[A-Z2-9]{4}$/);
      expect(code.slice(3)).not.toMatch(/[IO01]/);
    }
  });

  it('管理令牌只以摘要形式存在', () => {
    const t = generateManageToken();
    expect(t).toMatch(/^mt_[A-Za-z0-9_-]{20,}$/);
    expect(hashManageToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashManageToken(t)).not.toContain(t.slice(3, 12));
  });
});

// ─────────────────────────────────────────────────────────────── 读接口

describe('读', () => {
  it('/shop 给出时区和 Turnstile site key', async () => {
    const res = await get('/public/v1/shop');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.timezone).toBe('America/New_York');
    expect(body.onlineBooking.enabled).toBe(true);
    expect(body.onlineBooking.minMinutesAhead).toBe(120);
  });

  it('认不出的 key 一律 404，措辞和「停用了」一样', async () => {
    const res = await get('/public/v1/shop', { 'x-gf-public-key': 'pk_deadbeefdeadbeefdeadbeef' });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
  });

  it('⭐ /services 只给老板勾过的，没勾的一个都不出现', async () => {
    const res = await get('/public/v1/services');
    expect(res.statusCode).toBe(200);
    const ids = res.json().services.map((s: { id: string }) => s.id);
    expect(ids).toContain(serviceId);
    expect(ids).not.toContain(hiddenServiceId);
  });

  it('⭐ 加项单独放在 addons 里 —— 混在项目列表里客人会单独订一个「热石」', async () => {
    const res = await get('/public/v1/services');
    const body = res.json();

    expect(body.services.every((s: { isAddon: boolean }) => !s.isAddon)).toBe(true);
    expect(body.addons.every((s: { isAddon: boolean }) => s.isAddon)).toBe(true);
    if (addonId) {
      expect(body.addons.map((s: { id: string }) => s.id)).toContain(addonId);
      expect(body.services.map((s: { id: string }) => s.id)).not.toContain(addonId);
    }
  });

  it('加项会加长时长 —— 空档要按「主项目 + 加项」算', async () => {
    if (!addonId) return;
    const plain = await get(`/public/v1/availability?date=${bookDate}&serviceId=${serviceId}`);
    const withAddon = await get(
      `/public/v1/availability?date=${bookDate}&serviceId=${serviceId}&addonIds=${addonId}`);

    expect(withAddon.statusCode).toBe(200);
    // 少传加项的话，客人选到的是一个放不下他这一单的时间
    expect(withAddon.json().durationMin).toBeGreaterThan(plain.json().durationMin);
  });

  it('⭐ 拿加项当主项目查空档 → 400，前端分开展示不算校验', async () => {
    if (!addonId) return;
    const res = await get(`/public/v1/availability?date=${bookDate}&serviceId=${addonId}`);
    expect(res.statusCode).toBe(400);
    expect(res.json().details.reason).toBe('addon_not_bookable_alone');
  });

  it('/availability 给出这一天能放下这个项目的时刻', async () => {
    const res = await get(`/public/v1/availability?date=${bookDate}&serviceId=${serviceId}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.timezone).toBe('America/New_York');
    expect(Array.isArray(body.slots)).toBe(true);
    expect(body.slots.length).toBeGreaterThan(0);
    // ⭐ 同一时刻不许出现两次 —— 客人会以为网站坏了
    const starts = body.slots.map((s: { startsAt: string }) => s.startsAt);
    expect(new Set(starts).size).toBe(starts.length);
  });

  it('超出 maxDaysAhead 的日子当场拒绝', async () => {
    const far = addDays(bookDate, 400);
    const res = await get(`/public/v1/availability?date=${far}&serviceId=${serviceId}`);
    expect(res.statusCode).toBe(400);
    expect(res.json().details.reason).toBe('date_out_of_window');
  });
});

// ─────────────────────────────────────────────────────────────── 建单

describe('建预约', () => {
  it('正常订一单，前台那边看得到，来源是 web', async () => {
    __resetRateLimit();
    const res = await post('/public/v1/bookings', bookingPayload(), {
      'idempotency-key': randomUUID(),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.confirmationCode).toMatch(/^[A-Z]{2}-[A-Z2-9]{4}$/);
    expect(body.manageToken).toMatch(/^mt_/);

    const [row] = await withTenant(tenant, (tx) => tx<{
      source: string; code: string | null; digest: string | null; customer_id: string | null;
    }[]>`
      select source, confirmation_code as code, manage_token_digest as digest, customer_id
      from appointments where id = ${body.bookingId}`);
    expect(row!.source).toBe('web');
    expect(row!.code).toBe(body.confirmationCode);
    expect(row!.customer_id).not.toBeNull();
    // ⭐ 库里只有摘要，明文一个字都没有
    expect(row!.digest).toBe(hashManageToken(body.manageToken));
    expect(row!.digest).not.toBe(body.manageToken);
  });

  it('⭐ 确认短信入了发件箱：英文、一段、带退订说明', async () => {
    __resetRateLimit();
    const phone = `+1617222${String(Math.floor(Math.random() * 9000) + 1000)}`;
    const res = await post('/public/v1/bookings',
      bookingPayload({ customer: { name: 'Sms Guest', phone, smsOptIn: false } }),
      { 'idempotency-key': randomUUID() });
    expect(res.statusCode).toBe(201);

    const [row] = await withTenant(tenant, (tx) => tx<{
      kind: string; to_e164: string; body: string; segments: number; status: string;
    }[]>`
      select kind, to_e164, body, segments, status from sms_outbox
      where entity_id = ${res.json().bookingId}`);

    expect(row).toBeTruthy();
    expect(row!.kind).toBe('appointment_confirm');
    expect(row!.to_e164).toBe(phone);
    // ⭐ 成本：一段。而且必须是纯 ASCII —— 一个中文字符就翻倍
    expect(row!.segments).toBe(1);
    // eslint-disable-next-line no-control-regex
    expect(/^[\x20-\x7E]*$/.test(row!.body)).toBe(true);
    expect(row!.body).toContain('Reply STOP to opt out');
    // 🔴 一个字都不许提「回复 CANCEL」—— 那是运营商的退订关键词
    expect(row!.body.toUpperCase()).not.toContain('REPLY CANCEL');
  });

  it('⭐ 没留手机号也照样能订 —— 短信是增强项，不是前提', async () => {
    // 这一条盯的是宪法第 14 条：短信永不成为阻断点。
    // 公开预约必填手机号，所以这里直接走命令，模拟前台建的无号单
    __resetRateLimit();
    const out = await run<{ appointmentId: string }>('appointment.create', {
      customerId: null,
      walkInName: '无号散客',
      items: [{ serviceId, addonIds: [], membershipId: null, startsAt: nextSlot(), details: {} }],
      partySize: 1,
      source: 'desk',
    }, randomUUID());
    expect(out.appointmentId).toBeTruthy();

    const rows = await withTenant(tenant, (tx) => tx`
      select 1 from sms_outbox where entity_id = ${out.appointmentId}`);
    expect(rows.length).toBe(0);
  });

  it('⭐ 同一个幂等键提交两次 → 只建出一条，第二次 200', async () => {
    __resetRateLimit();
    const key = randomUUID();
    const payload = bookingPayload();
    const a = await post('/public/v1/bookings', payload, { 'idempotency-key': key });
    // 重试要换一个 Turnstile token（真实前端 reset widget 之后就是新的）
    const b = await post('/public/v1/bookings',
      { ...payload, turnstileToken: `tk_${randomUUID()}` }, { 'idempotency-key': key });

    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(200);
    expect(b.json().bookingId).toBe(a.json().bookingId);
    // ⭐ 重放不能返回一个验不过的新令牌
    expect(b.json().manageToken).toBeNull();
    expect(b.json().replayed).toBe(true);

    const [n] = await withTenant(tenant, (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from appointments where id = ${a.json().bookingId}`);
    expect(n!.n).toBe(1);
  });

  it('没带幂等键直接拒绝 —— 手抖点两下就是两条单', async () => {
    __resetRateLimit();
    const res = await post('/public/v1/bookings', bookingPayload());
    expect(res.statusCode).toBe(400);
    expect(res.json().details.reason).toBe('missing_idempotency_key');
  });

  it('⭐ 蜜罐命中 → 返回一个长得一模一样的 201，但库里没有这条单', async () => {
    __resetRateLimit();
    const res = await post('/public/v1/bookings',
      bookingPayload({ website: 'http://spam.example' }),
      { 'idempotency-key': randomUUID() });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    // 形状必须和真的一样，否则等于给对方一个探针
    expect(body.confirmationCode).toMatch(/^[A-Z]{2}-[A-Z2-9]{4}$/);
    expect(body.manageToken).toMatch(/^mt_/);

    const [n] = await withTenant(tenant, (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from appointments where id = ${body.bookingId}`);
    expect(n!.n).toBe(0);
  });

  it('三秒内交卷的当机器人处理，同样假装成功', async () => {
    __resetRateLimit();
    const res = await post('/public/v1/bookings',
      bookingPayload({ formElapsedMs: 900 }),
      { 'idempotency-key': randomUUID() });
    expect(res.statusCode).toBe(201);
    const [n] = await withTenant(tenant, (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from appointments where id = ${res.json().bookingId}`);
    expect(n!.n).toBe(0);
  });

  it('⭐ Turnstile token 用第二次 → 400，reason 是 bot_check_failed', async () => {
    __resetRateLimit();
    const token = `tk_${randomUUID()}`;
    const first = await post('/public/v1/bookings',
      bookingPayload({ turnstileToken: token }), { 'idempotency-key': randomUUID() });
    expect(first.statusCode).toBe(201);

    const again = await post('/public/v1/bookings',
      bookingPayload({ turnstileToken: token }), { 'idempotency-key': randomUUID() });
    expect(again.statusCode).toBe(400);
    expect(again.json().details.reason).toBe('bot_check_failed');
  });

  it('⭐ 白名单外的域名 → 403，而且带着 CORS 头（不然前端只看得到一句 TypeError）', async () => {
    __resetRateLimit();
    const res = await post('/public/v1/bookings', bookingPayload(),
      { 'idempotency-key': randomUUID(), origin: 'https://evil.example.com' });
    expect(res.statusCode).toBe(403);
    expect(res.json().details.reason).toBe('origin_not_allowed');
    expect(res.headers['access-control-allow-origin']).toBe('https://evil.example.com');
  });

  it('⭐ 订一个老板没勾「可在线预约」的项目 → 404，知道 id 也绕不回来', async () => {
    __resetRateLimit();
    const res = await post('/public/v1/bookings',
      bookingPayload({ items: [{ serviceId: hiddenServiceId, addonIds: [], staffId: null, startsAt: nextSlot() }] }),
      { 'idempotency-key': randomUUID() });
    expect(res.statusCode).toBe(404);
  });

  it('⭐ 拿加项当主项目提交 → 400，知道 id 也订不成一个「加项」', async () => {
    if (!addonId) return;
    __resetRateLimit();
    const res = await post('/public/v1/bookings',
      bookingPayload({ items: [{ serviceId: addonId, addonIds: [], staffId: null, startsAt: nextSlot() }] }),
      { 'idempotency-key': randomUUID() });
    expect(res.statusCode).toBe(400);
    expect(res.json().details.reason).toBe('addon_not_bookable_alone');
  });

  it('加项挂在主项目上照常能订，时长按两者之和落库', async () => {
    if (!addonId) return;
    __resetRateLimit();
    const res = await post('/public/v1/bookings',
      bookingPayload({ items: [{ serviceId, addonIds: [addonId], staffId: null, startsAt: nextSlot() }] }),
      { 'idempotency-key': randomUUID() });
    expect(res.statusCode).toBe(201);

    const [item] = await withTenant(tenant, (tx) => tx<{
      addon_ids: string[]; duration_min: number;
    }[]>`
      select addon_ids, duration_min from appointment_items
      where appointment_id = ${res.json().bookingId}`);
    expect(item!.addon_ids).toContain(addonId);
    expect(item!.duration_min).toBe(res.json().durationMin);
  });

  it('太急的单不让在线订，让他打电话', async () => {
    __resetRateLimit();
    const soon = new Date(Date.now() + 20 * 60_000).toISOString();
    const res = await post('/public/v1/bookings',
      bookingPayload({ items: [{ serviceId, addonIds: [], staffId: null, startsAt: soon }] }),
      { 'idempotency-key': randomUUID() });
    expect(res.statusCode).toBe(400);
    expect(res.json().details.reason).toBe('too_soon');
  });

  it('⭐ 同一个手机号占不满周六：未来第四条被拦下', async () => {
    const phone = `+1617999${String(Math.floor(Math.random() * 9000) + 1000)}`;
    const results: number[] = [];
    for (let i = 0; i < 4; i++) {
      // ⚠️ 每次都重置：按手机号的限频是 3 条/天，不重置的话第四条会先撞上
      // 限频（429）而不是我们要验的「未完成预约上限」。两条规则都要有，
      // 但这个用例只盯后者
      __resetRateLimit();
      const res = await post('/public/v1/bookings',
        bookingPayload({
          customer: { name: 'Squatter', phone, smsOptIn: false },
          items: [{ serviceId, addonIds: [], staffId: null, startsAt: nextSlot() }],
        }),
        { 'idempotency-key': randomUUID() });
      results.push(res.statusCode);
      if (res.statusCode === 400) {
        expect(res.json().details.reason).toBe('too_many_upcoming');
      }
    }
    expect(results.filter((s) => s === 201)).toHaveLength(3);
    expect(results[3]).toBe(400);
  });

  it('⭐ 限频：同一个 IP 连打，第六条被拦下并给出 retryAfterSec', async () => {
    __resetRateLimit();
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await post('/public/v1/bookings',
        bookingPayload({
          customer: {
            name: `Flood ${i}`,
            phone: `+1617111${String(1000 + i)}`,
            smsOptIn: false,
          },
        }),
        { 'idempotency-key': randomUUID() });
      codes.push(res.statusCode);
      if (res.statusCode === 429) {
        const body = res.json();
        expect(body.details.scope).toBe('ip');
        expect(body.details.retryAfterSec).toBeGreaterThan(0);
      }
    }
    expect(codes.filter((c) => c === 201)).toHaveLength(5);
    expect(codes[5]).toBe(429);
  });

  it('⭐ 宪法第 16 条：同号不同名 → 两个客户，绝不自动合并', async () => {
    __resetRateLimit();
    const phone = `+1617888${String(Math.floor(Math.random() * 9000) + 1000)}`;
    const mom = await post('/public/v1/bookings',
      bookingPayload({ customer: { name: '张丽华', phone, smsOptIn: false } }),
      { 'idempotency-key': randomUUID() });
    const daughter = await post('/public/v1/bookings',
      bookingPayload({
        customer: { name: '张小雨', phone, smsOptIn: false },
        items: [{ serviceId, addonIds: [], staffId: null, startsAt: nextSlot() }],
      }),
      { 'idempotency-key': randomUUID() });
    expect(mom.statusCode).toBe(201);
    expect(daughter.statusCode).toBe(201);

    const rows = await withTenant(tenant, (tx) => tx<{ customer_id: string }[]>`
      select customer_id from appointments
      where id = any(${[mom.json().bookingId, daughter.json().bookingId]})`);
    expect(new Set(rows.map((r) => r.customer_id)).size).toBe(2);
  });

  it('同号同名第二次 → 复用同一个客户，不攒重复', async () => {
    __resetRateLimit();
    const phone = `+1617777${String(Math.floor(Math.random() * 9000) + 1000)}`;
    const one = await post('/public/v1/bookings',
      bookingPayload({ customer: { name: 'Repeat Guest', phone, smsOptIn: false } }),
      { 'idempotency-key': randomUUID() });
    const two = await post('/public/v1/bookings',
      bookingPayload({
        customer: { name: '  repeat guest ', phone, smsOptIn: false },
        items: [{ serviceId, addonIds: [], staffId: null, startsAt: nextSlot() }],
      }),
      { 'idempotency-key': randomUUID() });
    expect(two.statusCode).toBe(201);

    const rows = await withTenant(tenant, (tx) => tx<{ customer_id: string }[]>`
      select customer_id from appointments
      where id = any(${[one.json().bookingId, two.json().bookingId]})`);
    expect(new Set(rows.map((r) => r.customer_id)).size).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────── 取消

describe('自助取消', () => {
  it('⭐ 拿到 bookingId 但没有令牌 → 404，不确认这条单存不存在', async () => {
    __resetRateLimit();
    const made = await post('/public/v1/bookings', bookingPayload(),
      { 'idempotency-key': randomUUID() });
    const id = made.json().bookingId;

    const wrong = await post(`/public/v1/bookings/${id}/cancel`,
      { manageToken: generateManageToken() });
    expect(wrong.statusCode).toBe(404);

    const [row] = await withTenant(tenant, (tx) => tx<{ status: string }[]>`
      select status from appointments where id = ${id}`);
    expect(row!.status).not.toBe('cancelled');
  });

  it('拿着自己的令牌能取消，取消之后前台那条也是 cancelled', async () => {
    __resetRateLimit();
    const made = await post('/public/v1/bookings', bookingPayload(),
      { 'idempotency-key': randomUUID() });
    const { bookingId, manageToken } = made.json();

    const res = await post(`/public/v1/bookings/${bookingId}/cancel`, { manageToken });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('cancelled');

    const [row] = await withTenant(tenant, (tx) => tx<{ status: string }[]>`
      select status from appointments where id = ${bookingId}`);
    expect(row!.status).toBe('cancelled');
  });

  it('取消第二次是幂等的，不是报错', async () => {
    __resetRateLimit();
    const made = await post('/public/v1/bookings', bookingPayload(),
      { 'idempotency-key': randomUUID() });
    const { bookingId, manageToken } = made.json();
    await post(`/public/v1/bookings/${bookingId}/cancel`, { manageToken });
    const again = await post(`/public/v1/bookings/${bookingId}/cancel`, { manageToken });
    expect(again.statusCode).toBe(200);
    expect(again.json().status).toBe('cancelled');
  });

  it('凭令牌能查自己那一条，查不到别人的', async () => {
    __resetRateLimit();
    const made = await post('/public/v1/bookings', bookingPayload(),
      { 'idempotency-key': randomUUID() });
    const { bookingId, manageToken } = made.json();

    const mine = await get(`/public/v1/bookings/${bookingId}?t=${manageToken}`);
    expect(mine.statusCode).toBe(200);
    expect(mine.json().items.length).toBeGreaterThan(0);

    const notMine = await get(`/public/v1/bookings/${bookingId}`);
    expect(notMine.statusCode).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────── 权限边界

describe('这串公开 key 到底能干什么', () => {
  it('⭐ 关掉在线预约之后，建单和拉项目都进不来（但取消还能用）', async () => {
    __resetRateLimit();
    const made = await post('/public/v1/bookings', bookingPayload(),
      { 'idempotency-key': randomUUID() });
    const { bookingId, manageToken } = made.json();

    await run('location.saveOnlineBooking', {
      enabled: false, maxDaysAhead: 60, minMinutesAhead: 120,
      requirePhoneVerification: false, cancelCutoffHours: 4,
    });
    try {
      const svc = await get('/public/v1/services');
      expect(svc.statusCode).toBe(403);
      expect(svc.json().details.reason).toBe('online_booking_disabled');

      const book = await post('/public/v1/bookings', bookingPayload(),
        { 'idempotency-key': randomUUID() });
      expect(book.statusCode).toBe(403);

      // ⭐ 昨天订了的客人今天必须还能取消 —— 取消不掉的人会直接不来
      const cancel = await post(`/public/v1/bookings/${bookingId}/cancel`, { manageToken });
      expect(cancel.statusCode).toBe(200);
    } finally {
      await run('location.saveOnlineBooking', {
        enabled: true, maxDaysAhead: 60, minMinutesAhead: 120,
        requirePhoneVerification: false, cancelCutoffHours: 4,
      });
    }
  });

  it('⭐ 拿它调需要登录的接口 —— 一条都调不动', async () => {
    for (const url of ['/v1/desk/day', '/v1/customers/search?q=chen', '/v1/desk/earnings']) {
      const res = await get(url);
      expect(res.statusCode).toBe(401);
    }
    const cmd = await post('/v1/commands/appointment.cancel', { input: {} });
    expect(cmd.statusCode).toBe(401);
  });

  it('⭐ 官网传的 override 一个字都不生效（公开入口没有超卖放行）', async () => {
    __resetRateLimit();
    const res = await post('/public/v1/bookings',
      { ...bookingPayload(), override: { reason: 'vip', note: '放我过去' } },
      { 'idempotency-key': randomUUID() });
    expect(res.statusCode).toBe(201);

    const [row] = await withTenant(tenant, (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from appointment_items
      where appointment_id = ${res.json().bookingId} and overbooked = true`);
    expect(row!.n).toBe(0);
  });
});
