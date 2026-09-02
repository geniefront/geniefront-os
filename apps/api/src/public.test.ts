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

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { withTenant, closeDb } from '@gf/db';
import { businessDateOf, wallMinuteToInstant } from '@gf/scheduling';
import { buildContext } from './actor';
import { dispatch } from './bus';
import { buildServer } from './server';
import { __setTurnstileVerifierForTests } from './public/turnstile';
import { __resetRateLimit } from './public/rateLimit';
import { normalizeOrigin, originAllowed, isHostedBookingOrigin } from './public/origin';
import {
  generateConfirmationCode, generateManageToken, hashManageToken, unwrapManageToken,
} from './public/bookingToken';
import { segmentsOf } from './sms/segments';
import { hostedManageBookingUrl } from './links';
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
// ⚠️ 要更多空档时**加密度，不要加天数**。
// 这个文件的班表夹具会给 bookDate 起 DAYS 天全部灌上 published 班 ——
// 而 phone.test.ts 靠「第 22 天没人排班」来测「那天没空档 → 往后找三天」。
// 我把 DAYS 从 14 拉到 40 那次，正好盖住了它，表现是一个完全无关的文件红了。
const PER_DAY = 7;
const DAYS = 14;
function nextSlot(): string {
  const i = slotSeq++;
  if (i >= PER_DAY * DAYS) throw new Error('测试用的空档发完了 —— 调大 DAYS');
  const day = addDays(bookDate, Math.floor(i / PER_DAY));
  // 10:30 起每小时一格，到 16:30。Seed has Sunday opening at 10:00,
  // so these slots are inside both the published shift and business hours.
  const minute = 10 * 60 + 30 + (i % PER_DAY) * 60;
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
/**
 * 最近一次 `bookingPayload()` 用的手机号。
 *
 * 批 2 之后取消和改期都要**手机后四位**，而号码是随机生成的 ——
 * 测试得知道自己刚才用的是哪一个。写成模块级变量而不是让每个用例
 * 自己造号码：造号码那一步一旦散开，迟早有人写成固定号码，
 * 然后「同号不同名 → 两个客户」那条用例就会跟着漂。
 */
let lastPhone = '';
const last4 = () => lastPhone.slice(-4);

function bookingPayload(over: Record<string, unknown> = {}) {
  lastPhone = `+1617555${String(Math.floor(Math.random() * 9000) + 1000)}`;
  return {
    turnstileToken: `tk_${randomUUID()}`,
    locale: 'en',
    customer: { name: 'Amy Chen', phone: lastPhone, smsOptIn: false },
    items: [{ serviceId, addonIds: [], staffId: null, startsAt: nextSlot() }],
    partySize: 1,
    website: '',
    formElapsedMs: 45_000,
    ...over,
  };
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  if (!process.env['APP_JWT_SECRET'] || process.env['APP_JWT_SECRET'].length < 32) {
    process.env['APP_JWT_SECRET'] = 'public-booking-test-secret-at-least-32-chars';
  }
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
  // Seed already contains future bookings for the next 14 days. Start after
  // that window so this suite tests its own capacity, not demo appointments.
  bookDate = addDays(today, 16);

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
   * ⚠️ 还有一条**不是 web 的**要清：「没留手机号也照样能订」那个用例
   * 走的是 `appointment.create` + `source='desk'`（公开入口必填手机号，
   * 测不了无号单）。上面那条 `source='web'` 的清理漏了它。
   *
   * 后果是隐性的：每跑一次就在同一格多压一张单，跑到第六次
   * （门店容量 = 在班可预约技师数）那个用例开始报 LOCATION_OVER_CAPACITY，
   * 而报错的位置和真正的原因隔了好几个用例。按 walk_in_name 精确删，
   * 碰不到任何手工建的数据。
   */
  await withTenant(tenant, (tx) => tx`
    delete from appointments
    where location_id = ${NAIL_LOC} and source = 'desk'
      and walk_in_name = '无号散客' and business_date >= ${bookDate}`);
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

    const [appt] = await withTenant(tenant, (tx) => tx<{ digest: string | null }[]>`
      select manage_token_digest as digest from appointments where id = ${out.appointmentId}`);
    expect(appt?.digest).toBeNull();
  });

  it('desk appointment with a phone stores a digest and does not return the raw token', async () => {
    const [cust] = await withTenant(tenant, (tx) => tx<{ id: string }[]>`
      select id from customers where org_id = ${NAIL_ORG} and phone_e164 is not null limit 1`);
    const out = await dispatch<{ appointmentId: string }>(
      'appointment.create',
      {
        customerId: cust!.id,
        items: [{ serviceId, addonIds: [], membershipId: null, startsAt: nextSlot(), details: {} }],
        partySize: 1,
        source: 'desk',
      },
      ctx,
      { idempotencyKey: randomUUID() },
    );
    expect(out.result).not.toHaveProperty('manageToken');
    const [row] = await withTenant(tenant, (tx) => tx<{
      digest: string | null; after: Record<string, unknown>;
    }[]>`
      select a.manage_token_digest as digest, al.after
        from appointments a
        join audit_log al on al.entity_id = a.id and al.command = 'appointment.create'
       where a.id = ${out.result.appointmentId}`);
    expect(row?.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row?.after)).not.toMatch(/mt_/);
    expect(row?.after).not.toHaveProperty('manageToken');
    await withTenant(tenant, (tx) => tx`
      delete from appointments where id = ${out.result.appointmentId}`);
  });

  it('phone_manual appointment with a phone also stores a digest', async () => {
    const [cust] = await withTenant(tenant, (tx) => tx<{ id: string }[]>`
      select id from customers where org_id = ${NAIL_ORG} and phone_e164 is not null limit 1`);
    const out = await dispatch<{ appointmentId: string }>(
      'appointment.create',
      {
        customerId: cust!.id,
        items: [{ serviceId, addonIds: [], membershipId: null, startsAt: nextSlot(), details: {} }],
        partySize: 1,
        source: 'phone_manual',
      },
      ctx,
      { idempotencyKey: randomUUID() },
    );
    expect(out.result).not.toHaveProperty('manageToken');
    const [row] = await withTenant(tenant, (tx) => tx<{ digest: string | null }[]>`
      select manage_token_digest as digest from appointments where id = ${out.result.appointmentId}`);
    expect(row?.digest).toMatch(/^[0-9a-f]{64}$/);
    await withTenant(tenant, (tx) => tx`
      delete from appointments where id = ${out.result.appointmentId}`);
  });

  it('desk appointment for a customer without a phone does not get a manage digest', async () => {
    const [cust] = await withTenant(tenant, (tx) => tx<{ id: string }[]>`
      insert into customers (org_id, primary_location_id, display_name, source)
      values (${NAIL_ORG}, ${NAIL_LOC}, 'No Phone Guest', 'desk')
      returning id`);
    const out = await dispatch<{ appointmentId: string }>(
      'appointment.create',
      {
        customerId: cust!.id,
        items: [{ serviceId, addonIds: [], membershipId: null, startsAt: nextSlot(), details: {} }],
        partySize: 1,
        source: 'desk',
      },
      ctx,
      { idempotencyKey: randomUUID() },
    );
    const [row] = await withTenant(tenant, (tx) => tx<{ digest: string | null }[]>`
      select manage_token_digest as digest from appointments where id = ${out.result.appointmentId}`);
    expect(row?.digest).toBeNull();
    await withTenant(tenant, (tx) => tx`
      delete from appointments where id = ${out.result.appointmentId}`);
    await withTenant(tenant, (tx) => tx`
      delete from customers where id = ${cust!.id}`);
  });

  it('canonical email manage URL is /l/{slug}#g/{token} when the page flag is on', async () => {
    __resetRateLimit();
    /**
     * Task 4 is backend/token issuance only. SMS still does not embed the
     * manage link (Task 8). Email uses hostedManageBookingUrl, which is
     * null until BOOKING_MANAGE_PAGE_ENABLED=1.
     */
    const prev = process.env['BOOKING_MANAGE_PAGE_ENABLED'];
    process.env['BOOKING_MANAGE_PAGE_ENABLED'] = '1';
    try {
      const payload = bookingPayload();
      Object.assign(payload.customer as { email?: string }, {
        email: 'guest-manage-url@maildrop.cc',
      });
      const made = await post('/public/v1/bookings', payload, { 'idempotency-key': randomUUID() });
      expect(made.statusCode).toBe(201);
      const token = made.json().manageToken as string;
      const [mail] = await withTenant(tenant, (tx) => tx<{ html: string; text: string }[]>`
        select body_html as html, body_text as text from email_outbox
        where entity_id = ${made.json().bookingId} and kind = 'appointment_confirm'`);
      expect(mail).toBeTruthy();
      expect(mail!.html).toContain('/l/lotus-nails#g/');
      expect(mail!.html).toContain(token);
      expect(mail!.html).not.toContain('/l/lotus-nails/g/');
      expect(mail!.html).not.toContain('/b/');
      expect(mail!.html).not.toContain('k=pk_');
      expect(mail!.text).toContain(`/l/lotus-nails#g/${token}`);
      const [sms] = await withTenant(tenant, (tx) => tx<{ body: string; segments: number }[]>`
        select body, segments from sms_outbox
        where entity_id = ${made.json().bookingId} and kind = 'appointment_confirm'`);
      expect(sms?.body ?? '').toContain(`/l/lotus-nails#g/${token}`);
      expect(sms!.body.toUpperCase()).not.toContain('REPLY CANCEL');
      expect(sms!.segments).toBeGreaterThanOrEqual(2);
      expect(sms!.segments).toBe(segmentsOf(sms!.body));
    } finally {
      if (prev === undefined) delete process.env['BOOKING_MANAGE_PAGE_ENABLED'];
      else process.env['BOOKING_MANAGE_PAGE_ENABLED'] = prev;
    }
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
    const prices = await withTenant(tenant, (tx) => tx<{ id: string; price: number }[]>`
      select id, base_price_cents as price from services
      where id = any(${[serviceId, addonId]})`);
    const byId = new Map(prices.map((p) => [p.id, p.price]));
    const expectedCents = byId.get(serviceId)! + byId.get(addonId)!;

    const res = await post('/public/v1/bookings',
      bookingPayload({ items: [{ serviceId, addonIds: [addonId], staffId: null, startsAt: nextSlot() }] }),
      { 'idempotency-key': randomUUID() });
    expect(res.statusCode).toBe(201);

    const [item] = await withTenant(tenant, (tx) => tx<{
      addon_ids: string[]; duration_min: number; price_cents_snapshot: number;
    }[]>`
      select addon_ids, duration_min, price_cents_snapshot from appointment_items
      where appointment_id = ${res.json().bookingId}`);
    expect(item!.addon_ids).toContain(addonId);
    expect(item!.duration_min).toBe(res.json().durationMin);
    expect(item!.price_cents_snapshot).toBe(expectedCents);

    const shop = await withTenant(tenant, (tx) => tx<{ slug: string }[]>`
      select slug from locations where id = ${NAIL_LOC}`);
    const detail = await app.inject({
      method: 'POST',
      url: '/public/v1/hosted/manage',
      payload: { slug: shop[0]!.slug, manageToken: res.json().manageToken },
      headers: { origin: 'https://book.geniefront.com' },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().booking.priceCents).toBe(expectedCents);
    expect(detail.json().booking.priceCents).toBe(
      byId.get(serviceId)! + byId.get(addonId)!,
    );
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

    const res = await post(`/public/v1/bookings/${bookingId}/cancel`,
      { manageToken, last4: last4() });
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
    const l4 = last4();
    await post(`/public/v1/bookings/${bookingId}/cancel`, { manageToken, last4: l4 });
    // ⚠️ 第二次**故意不带 last4** —— 已经取消的单不该再验，
    // 否则幂等重试会白白消耗锁定计数
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

// ────────────────────────────────────────────────── 后四位与自助改期（批 2）

describe('手机后四位是第二道闸', () => {
  it('⭐ 不带后四位取消不掉 —— 光有令牌不够了', async () => {
    __resetRateLimit();
    const made = await post('/public/v1/bookings', bookingPayload(),
      { 'idempotency-key': randomUUID() });
    const { bookingId, manageToken } = made.json();

    const res = await post(`/public/v1/bookings/${bookingId}/cancel`, { manageToken });
    expect(res.statusCode).toBe(403);
    expect(res.json().details.reason).toBe('last4_mismatch');

    const [row] = await withTenant(tenant, (tx) => tx<{ status: string }[]>`
      select status from appointments where id = ${bookingId}`);
    expect(row!.status).not.toBe('cancelled');
  });

  it('⭐ 连错三次锁 15 分钟，而且对的那个也进不去', async () => {
    __resetRateLimit();
    const made = await post('/public/v1/bookings', bookingPayload(),
      { 'idempotency-key': randomUUID() });
    const { bookingId, manageToken } = made.json();
    const right = last4();
    const wrong = right === '0000' ? '1111' : '0000';

    for (let i = 1; i <= 3; i++) {
      const r = await post(`/public/v1/bookings/${bookingId}/cancel`,
        { manageToken, last4: wrong });
      expect(r.statusCode).toBe(403);
      expect(r.json().details.attemptsLeft).toBe(3 - i);
    }

    // 锁上之后连正确答案都不认 —— 否则锁定形同虚设
    const locked = await post(`/public/v1/bookings/${bookingId}/cancel`,
      { manageToken, last4: right });
    expect(locked.statusCode).toBe(403);
    expect(locked.json().details.reason).toBe('last4_locked');
    expect(locked.json().details.retryAfterSec).toBeGreaterThan(0);
  });

  it('⭐ 锁定按预约维度，不按 IP —— 隔壁那单不受连累', async () => {
    __resetRateLimit();
    const a = await post('/public/v1/bookings', bookingPayload(),
      { 'idempotency-key': randomUUID() });
    const aId = a.json().bookingId; const aToken = a.json().manageToken;

    const b = await post('/public/v1/bookings', bookingPayload(),
      { 'idempotency-key': randomUUID() });
    const bId = b.json().bookingId; const bToken = b.json().manageToken;
    const bLast4 = last4();

    // 把 A 那单锁死（同一个 IP，测试里全是 127.0.0.1）
    for (let i = 0; i < 3; i++) {
      await post(`/public/v1/bookings/${aId}/cancel`, { manageToken: aToken, last4: '0000' });
    }

    // B 那单照常能取消。按 IP 锁的话这里会 403 ——
    // 而一家店的客人常常连的是同一个 WiFi
    const ok = await post(`/public/v1/bookings/${bId}/cancel`,
      { manageToken: bToken, last4: bLast4 });
    expect(ok.statusCode).toBe(200);
  });

  it('猜对了就把失败计数清掉，下次不带着旧账', async () => {
    __resetRateLimit();
    const made = await post('/public/v1/bookings', bookingPayload(),
      { 'idempotency-key': randomUUID() });
    const { bookingId, manageToken } = made.json();
    const right = last4();

    await post(`/public/v1/bookings/${bookingId}/cancel`, { manageToken, last4: '0000' });
    await post(`/public/v1/bookings/${bookingId}/reschedule`,
      { manageToken, last4: right, startsAt: nextSlot() });

    const [row] = await withTenant(tenant, (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from booking_manage_attempts
      where appointment_id = ${bookingId}`);
    expect(row!.n).toBe(0);
  });
});

describe('自助改期（批 2）', () => {
  it('⭐ 原子改期：改成功之后原单还是那一条，只是时间变了', async () => {
    __resetRateLimit();
    const made = await post('/public/v1/bookings', bookingPayload(),
      { 'idempotency-key': randomUUID() });
    const { bookingId, manageToken } = made.json();
    const target = nextSlot();

    const res = await post(`/public/v1/bookings/${bookingId}/reschedule`,
      { manageToken, last4: last4(), startsAt: target });
    expect(res.statusCode).toBe(200);

    // ⭐ 不是「取消 + 重订」—— 还是同一条单，status 没变成 cancelled
    const [row] = await withTenant(tenant, (tx) => tx<{ status: string; n: number }[]>`
      select status, self_reschedule_count as n from appointments where id = ${bookingId}`);
    expect(row!.status).not.toBe('cancelled');
    expect(row!.n).toBe(1);
  });

  it('⭐ 改够次数之后只能打电话', async () => {
    __resetRateLimit();
    const made = await post('/public/v1/bookings', bookingPayload(),
      { 'idempotency-key': randomUUID() });
    const { bookingId, manageToken } = made.json();
    const l4 = last4();

    // 默认上限 2
    for (let i = 0; i < 2; i++) {
      const r = await post(`/public/v1/bookings/${bookingId}/reschedule`,
        { manageToken, last4: l4, startsAt: nextSlot() });
      expect(r.statusCode).toBe(200);
    }

    const third = await post(`/public/v1/bookings/${bookingId}/reschedule`,
      { manageToken, last4: l4, startsAt: nextSlot() });
    expect(third.statusCode).toBe(403);
    expect(third.json().details.reason).toBe('reschedule_limit_reached');
  });

  it('⭐ 撞了容量不消耗改期次数 —— 失败的尝试不该扣配额', async () => {
    __resetRateLimit();
    const made = await post('/public/v1/bookings', bookingPayload(),
      { 'idempotency-key': randomUUID() });
    const { bookingId, manageToken } = made.json();

    // 太急的时间会被前置校验挡下，走不到 reschedule 命令
    const bad = await post(`/public/v1/bookings/${bookingId}/reschedule`,
      { manageToken, last4: last4(), startsAt: new Date(Date.now() + 10 * 60_000).toISOString() });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().details.reason).toBe('too_soon');

    const [row] = await withTenant(tenant, (tx) => tx<{ n: number }[]>`
      select self_reschedule_count as n from appointments where id = ${bookingId}`);
    expect(row!.n).toBe(0);
  });

  it('已经取消的单改不了', async () => {
    __resetRateLimit();
    const made = await post('/public/v1/bookings', bookingPayload(),
      { 'idempotency-key': randomUUID() });
    const { bookingId, manageToken } = made.json();
    const l4 = last4();
    await post(`/public/v1/bookings/${bookingId}/cancel`, { manageToken, last4: l4 });

    const res = await post(`/public/v1/bookings/${bookingId}/reschedule`,
      { manageToken, last4: l4, startsAt: nextSlot() });
    expect(res.statusCode).toBe(409);
  });

  it('completed and no_show appointments cannot be cancelled or rescheduled', async () => {
    for (const status of ['completed', 'no_show'] as const) {
      __resetRateLimit();
      const made = await post('/public/v1/bookings', bookingPayload(),
        { 'idempotency-key': randomUUID() });
      const { bookingId, manageToken } = made.json();
      const l4 = last4();
      await withTenant(tenant, (tx) => tx`
        update appointments set status = ${status} where id = ${bookingId}`);

      const cancel = await post(`/public/v1/bookings/${bookingId}/cancel`,
        { manageToken, last4: l4 });
      expect(cancel.statusCode).toBe(403);
      expect(cancel.json().details.reason).toBe('not_mutable');

      const reschedule = await post(`/public/v1/bookings/${bookingId}/reschedule`,
        { manageToken, last4: l4, startsAt: nextSlot() });
      expect(reschedule.statusCode).toBe(403);
      expect(reschedule.json().details.reason).toBe('not_mutable');

      const [row] = await withTenant(tenant, (tx) => tx<{ status: string }[]>`
        select status from appointments where id = ${bookingId}`);
      expect(row!.status).toBe(status);
    }
  });

  it('老板关掉改期开关之后这条路就没了（取消不受影响）', async () => {
    __resetRateLimit();
    const made = await post('/public/v1/bookings', bookingPayload(),
      { 'idempotency-key': randomUUID() });
    const { bookingId, manageToken } = made.json();
    const l4 = last4();

    await run('location.saveOnlineBooking', {
      enabled: true, maxDaysAhead: 60, minMinutesAhead: 120,
      requirePhoneVerification: false, cancelCutoffHours: 4,
      rescheduleEnabled: false, selfRescheduleMax: 2,
    });
    try {
      const r = await post(`/public/v1/bookings/${bookingId}/reschedule`,
        { manageToken, last4: l4, startsAt: nextSlot() });
      expect(r.statusCode).toBe(403);
      expect(r.json().details.reason).toBe('reschedule_disabled');

      // 取消照常 —— 关掉改期不该把客人逼成 no-show
      const c = await post(`/public/v1/bookings/${bookingId}/cancel`, { manageToken, last4: l4 });
      expect(c.statusCode).toBe(200);
    } finally {
      await run('location.saveOnlineBooking', {
        enabled: true, maxDaysAhead: 60, minMinutesAhead: 120,
        requirePhoneVerification: false, cancelCutoffHours: 4,
      });
    }
  });

  it('⭐ 查空档时排除本单，客人才看得到「原地往后延」那一格', async () => {
    __resetRateLimit();
    const made = await post('/public/v1/bookings', bookingPayload(),
      { 'idempotency-key': randomUUID() });
    const { bookingId } = made.json();
    const [appt] = await withTenant(tenant, (tx) => tx<{ d: string }[]>`
      select business_date::text as d from appointments where id = ${bookingId}`);

    const q = `date=${appt!.d}&serviceId=${serviceId}`;
    const without = await get(`/public/v1/availability?${q}`);
    const withEx = await get(`/public/v1/availability?${q}&excludeBookingId=${bookingId}`);

    expect(without.statusCode).toBe(200);
    expect(withEx.statusCode).toBe(200);
    // 排除本单之后至少不会更少 —— 他自己占的那些格子回来了
    expect(withEx.json().slots.length).toBeGreaterThanOrEqual(without.json().slots.length);
  });
});

describe('这串公开 key 到底能干什么', () => {
  it('⭐ 关掉在线预约之后，建单和拉项目都进不来（但取消还能用）', async () => {
    __resetRateLimit();
    const made = await post('/public/v1/bookings', bookingPayload(),
      { 'idempotency-key': randomUUID() });
    const { bookingId, manageToken } = made.json();
    const l4 = last4();

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
      const cancel = await post(`/public/v1/bookings/${bookingId}/cancel`,
        { manageToken, last4: l4 });
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

describe('hosted shop slug', () => {
  async function nailShop() {
    const [row] = await withTenant(tenant, (tx) => tx<{
      slug: string; public_key: string; status: string;
    }[]>`
      select slug, public_key, status from locations where id = ${NAIL_LOC}`);
    return row!;
  }

  it('resolves an active shop and returns the public key', async () => {
    const shop = await nailShop();
    const res = await app.inject({
      method: 'GET',
      url: `/public/v1/hosted/shops/${shop.slug}?locale=en`,
      headers: { origin: 'https://book.geniefront.com' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.slug).toBe(shop.slug);
    expect(body.publicKey).toBe(shop.public_key);
    expect(body.timezone).toBe('America/New_York');
    expect(body).not.toHaveProperty('allowedOrigins');
    expect(body).not.toHaveProperty('settings');
    expect(body).not.toHaveProperty('orgId');
    expect(body).not.toHaveProperty('locationId');
  });

  it('treats case and punctuation variants as the same shop', async () => {
    const shop = await nailShop();
    const variant = shop.slug.toUpperCase().replace(/-/g, '_');
    const res = await app.inject({
      method: 'GET',
      url: `/public/v1/hosted/shops/${encodeURIComponent(variant)}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().publicKey).toBe(shop.public_key);
  });

  it('missing, setup, suspended, and closed shops share the same 404', async () => {
    const missing = await app.inject({
      method: 'GET',
      url: '/public/v1/hosted/shops/no-such-shop-zzzz',
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().code).toBe('NOT_FOUND');
    expect(missing.json().details).toEqual({ entity: 'shop' });

    const shop = await nailShop();
    try {
      for (const status of ['setup', 'suspended', 'closed'] as const) {
        await withTenant(tenant, (tx) => tx`
          update locations set status = ${status} where id = ${NAIL_LOC}`);
        const res = await app.inject({
          method: 'GET',
          url: `/public/v1/hosted/shops/${shop.slug}`,
        });
        expect(res.statusCode).toBe(404);
        expect(res.json()).toEqual(missing.json());
      }
    } finally {
      await withTenant(tenant, (tx) => tx`
        update locations set status = ${shop.status} where id = ${NAIL_LOC}`);
    }
  });

  it('resolved public key cannot call authenticated routes', async () => {
    const shop = await nailShop();
    const boot = await app.inject({
      method: 'GET',
      url: `/public/v1/hosted/shops/${shop.slug}`,
    });
    const key = boot.json().publicKey as string;
    expect(key).toMatch(/^pk_/);
    for (const url of ['/v1/desk/day', '/v1/customers/search?q=chen', '/v1/desk/earnings']) {
      const res = await app.inject({
        method: 'GET', url,
        headers: { 'x-gf-public-key': key },
      });
      expect(res.statusCode).toBe(401);
    }
  });
});

describe('hosted manage token resolution', () => {
  const managePost = (body: object) => app.inject({
    method: 'POST',
    url: '/public/v1/hosted/manage',
    payload: body,
    headers: { origin: 'https://book.geniefront.com' },
  }) as unknown as Promise<Injected>;

  it('resolves a valid token to exactly one appointment and shop', async () => {
    const made = await post('/public/v1/bookings', bookingPayload(),
      { 'idempotency-key': randomUUID() });
    expect(made.statusCode).toBe(201);
    const token = made.json().manageToken as string;
    const shop = await withTenant(tenant, (tx) => tx<{ slug: string }[]>`
      select slug from locations where id = ${NAIL_LOC}`);
    const res = await managePost({ slug: shop[0]!.slug, manageToken: token });
    expect(res.statusCode).toBe(200);
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    const body = res.json();
    expect(body.booking.bookingId).toBe(made.json().bookingId);
    expect(body.booking.status).toBe('booked');
    expect(body.shop.slug).toBe(shop[0]!.slug);
    expect(body.booking.actions.canReschedule).toBe(true);
    expect(body.booking.actions.canCancel).toBe(true);
    expect(body.booking.actions.canRebook).toBe(true);
    expect(typeof body.booking.priceCents).toBe('number');
    expect(body.booking.policy.cancelCutoffHours).toBeGreaterThan(0);
    expect(JSON.stringify(body)).not.toContain(token);
    expect(JSON.stringify(body)).not.toContain(lastPhone);
    expect(body).not.toHaveProperty('phone');
    expect(body.booking).not.toHaveProperty('phone');
    expect(body.booking).not.toHaveProperty('email');
    expect(body.booking).not.toHaveProperty('orgId');
    expect(body.booking).not.toHaveProperty('locationId');
  });

  it('raw manage token is absent from the issued URL path, audit, and manage JSON', async () => {
    const made = await post('/public/v1/bookings', bookingPayload(),
      { 'idempotency-key': randomUUID() });
    expect(made.statusCode).toBe(201);
    const token = made.json().manageToken as string;
    const prev = process.env['BOOKING_MANAGE_PAGE_ENABLED'];
    process.env['BOOKING_MANAGE_PAGE_ENABLED'] = '1';
    try {
      const url = hostedManageBookingUrl({ shopSlug: 'lotus-nails', manageToken: token })!;
      const parsed = new URL(url);
      expect(parsed.pathname).toBe('/l/lotus-nails');
      expect(parsed.pathname).not.toContain(token);
      expect(parsed.hash).toBe(`#g/${token}`);
    } finally {
      if (prev === undefined) delete process.env['BOOKING_MANAGE_PAGE_ENABLED'];
      else process.env['BOOKING_MANAGE_PAGE_ENABLED'] = prev;
    }

    const boot = await managePost({ slug: 'lotus-nails', manageToken: token });
    expect(boot.statusCode).toBe(200);
    expect(JSON.stringify(boot.json())).not.toContain(token);

    const [audit] = await withTenant(tenant, (tx) => tx<{ after: unknown }[]>`
      select after from audit_log
      where entity_id = ${made.json().bookingId} and command = 'appointment.create'`);
    expect(JSON.stringify(audit?.after ?? {})).not.toMatch(/mt_/);
    expect(JSON.stringify(audit?.after ?? {})).not.toContain(token);
  });

  it('wrong token and wrong-shop token share the same 404', async () => {
    const made = await post('/public/v1/bookings', bookingPayload(),
      { 'idempotency-key': randomUUID() });
    const token = made.json().manageToken as string;
    const missing = await managePost({ slug: 'lotus-nails', manageToken: generateManageToken() });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().code).toBe('NOT_FOUND');
    expect(JSON.stringify(missing.json())).not.toMatch(/mt_/);

    const cross = await managePost({ slug: 'golden-foot', manageToken: token });
    expect(cross.statusCode).toBe(404);
    expect(cross.json()).toEqual(missing.json());
  });

  it('setup, suspended, and closed shops share the same manage 404 as a missing token', async () => {
    __resetRateLimit();
    const made = await post('/public/v1/bookings', bookingPayload(),
      { 'idempotency-key': randomUUID() });
    const token = made.json().manageToken as string;
    const missing = await managePost({ slug: 'lotus-nails', manageToken: generateManageToken() });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().code).toBe('NOT_FOUND');
    expect(missing.json().details).toEqual({ entity: 'booking' });

    const [shop] = await withTenant(tenant, (tx) => tx<{ status: string }[]>`
      select status from locations where id = ${NAIL_LOC}`);
    try {
      for (const status of ['setup', 'suspended', 'closed'] as const) {
        await withTenant(tenant, (tx) => tx`
          update locations set status = ${status} where id = ${NAIL_LOC}`);
        const res = await managePost({ slug: 'lotus-nails', manageToken: token });
        expect(res.statusCode).toBe(404);
        expect(res.json()).toEqual(missing.json());
      }
    } finally {
      await withTenant(tenant, (tx) => tx`
        update locations set status = ${shop!.status} where id = ${NAIL_LOC}`);
    }
  });

  it('cancelled appointments remain resolvable', async () => {
    const made = await post('/public/v1/bookings', bookingPayload(),
      { 'idempotency-key': randomUUID() });
    const token = made.json().manageToken as string;
    const id = made.json().bookingId as string;
    const cancel = await post(`/public/v1/bookings/${id}/cancel`,
      { manageToken: token, last4: last4() });
    expect(cancel.statusCode).toBe(200);

    const res = await managePost({ slug: 'lotus-nails', manageToken: token });
    expect(res.statusCode).toBe(200);
    expect(res.json().booking.status).toBe('cancelled');
    expect(res.json().booking.bookingId).toBe(id);
    expect(res.json().booking.actions.canReschedule).toBe(false);
    expect(res.json().booking.actions.canCancel).toBe(false);
    expect(res.json().booking.actions.canRebook).toBe(true);
    expect(res.json().booking.actions.reason).toBe('not_mutable');
    expect(res.json().booking.items[0].name).toBeTruthy();
    expect(res.json().booking.startsAt).toBeTruthy();
  });

  it('completed and no_show appointments are read-only and still show service/time', async () => {
    for (const status of ['completed', 'no_show'] as const) {
      __resetRateLimit();
      const made = await post('/public/v1/bookings', bookingPayload(),
        { 'idempotency-key': randomUUID() });
      const token = made.json().manageToken as string;
      const id = made.json().bookingId as string;
      await withTenant(tenant, (tx) => tx`
        update appointments set status = ${status} where id = ${id}`);
      const res = await managePost({ slug: 'lotus-nails', manageToken: token });
      expect(res.statusCode).toBe(200);
      expect(res.json().booking.status).toBe(status);
      expect(res.json().booking.actions.canReschedule).toBe(false);
      expect(res.json().booking.actions.canCancel).toBe(false);
      expect(res.json().booking.actions.reason).toBe('not_mutable');
      expect(res.json().booking.items[0].name).toBeTruthy();
    }
  });

  it('top-level timing uses the appointment window, not item sequence', async () => {
    __resetRateLimit();
    const made = await post('/public/v1/bookings', bookingPayload(),
      { 'idempotency-key': randomUUID() });
    expect(made.statusCode).toBe(201);
    const id = made.json().bookingId as string;
    const token = made.json().manageToken as string;

    // Keep both items inside the original business day, but reverse seq vs time:
    // seq 0 starts later, seq 1 starts earlier.
    await withTenant(tenant, async (tx) => {
      const [item] = await tx<{ id: string }[]>`
        select id from appointment_items where appointment_id = ${id}`;
      await tx`update appointment_items set seq = 1 where id = ${item!.id}`;
      await tx`
        insert into appointment_items
          (org_id, location_id, appointment_id, service_id, addon_ids, membership_id,
           is_request, resource_id, starts_at, ends_at, price_cents_snapshot,
           duration_min, seq, details)
        select org_id, location_id, appointment_id, service_id, addon_ids, membership_id,
               is_request, resource_id,
               starts_at + interval '60 minutes',
               ends_at + interval '60 minutes',
               price_cents_snapshot, duration_min, 0, details
          from appointment_items where id = ${item!.id}`;
      await tx`
        update appointments set
          starts_at = (select min(starts_at) from appointment_items where appointment_id = ${id}),
          ends_at = (select max(ends_at) from appointment_items where appointment_id = ${id})
        where id = ${id}`;
    });

    const [appt] = await withTenant(tenant, (tx) => tx<{
      starts_at: string; ends_at: string;
    }[]>`
      select starts_at::text as starts_at, ends_at::text as ends_at
        from appointments where id = ${id}`);
    const items = await withTenant(tenant, (tx) => tx<{
      seq: number; starts_at: string; ends_at: string; duration_min: number;
    }[]>`
      select seq, starts_at::text as starts_at, ends_at::text as ends_at, duration_min
        from appointment_items where appointment_id = ${id} order by seq`);
    expect(items).toHaveLength(2);
    expect(items[0]!.starts_at).not.toBe(items[1]!.starts_at);
    expect(Date.parse(items[0]!.starts_at)).toBeGreaterThan(Date.parse(items[1]!.starts_at));

    const res = await managePost({ slug: 'lotus-nails', manageToken: token });
    expect(res.statusCode).toBe(200);
    const booking = res.json().booking;
    expect(Date.parse(booking.startsAt)).toBe(Date.parse(appt!.starts_at));
    expect(Date.parse(booking.endsAt)).toBe(Date.parse(appt!.ends_at));
    expect(Date.parse(booking.startsAt)).not.toBe(Date.parse(items[0]!.starts_at));
    const elapsed = Math.round(
      (Date.parse(appt!.ends_at) - Date.parse(appt!.starts_at)) / 60_000);
    expect(booking.durationMin).toBe(elapsed);
    const summed = items.reduce((n, i) => n + i.duration_min, 0);
    expect(booking.durationMin).not.toBe(summed);
    expect(booking.items[0].startsAt).not.toBe(booking.items[1].startsAt);
  });

  it('simultaneous party items keep item durations but use the shared window', async () => {
    __resetRateLimit();
    const start = nextSlot();
    const made = await post('/public/v1/bookings',
      bookingPayload({
        items: [
          { serviceId, addonIds: [], staffId: null, startsAt: start },
          { serviceId, addonIds: [], staffId: null, startsAt: start },
        ],
        partySize: 2,
      }),
      { 'idempotency-key': randomUUID() });
    expect(made.statusCode).toBe(201);
    const id = made.json().bookingId as string;
    const token = made.json().manageToken as string;
    const [appt] = await withTenant(tenant, (tx) => tx<{
      starts_at: string; ends_at: string;
    }[]>`
      select starts_at::text as starts_at, ends_at::text as ends_at
        from appointments where id = ${id}`);
    const items = await withTenant(tenant, (tx) => tx<{ duration_min: number }[]>`
      select duration_min from appointment_items where appointment_id = ${id}`);
    const res = await managePost({ slug: 'lotus-nails', manageToken: token });
    const booking = res.json().booking;
    const elapsed = Math.round(
      (Date.parse(appt!.ends_at) - Date.parse(appt!.starts_at)) / 60_000);
    expect(booking.durationMin).toBe(elapsed);
    expect(booking.durationMin).toBe(items[0]!.duration_min);
    expect(booking.durationMin).not.toBe(items[0]!.duration_min + items[1]!.duration_min);
    expect(booking.items).toHaveLength(2);
  });

  it('stores a wrapped manage token that unwraps to the issued raw token', async () => {
    __resetRateLimit();
    const made = await post('/public/v1/bookings', bookingPayload(),
      { 'idempotency-key': randomUUID() });
    expect(made.statusCode).toBe(201);
    const token = made.json().manageToken as string;
    const [row] = await withTenant(tenant, (tx) => tx<{
      digest: string; wrapped: Buffer | Uint8Array | null;
    }[]>`
      select manage_token_digest as digest, manage_token_wrapped as wrapped
        from appointments where id = ${made.json().bookingId}`);
    expect(row?.digest).toBe(hashManageToken(token));
    expect(row?.wrapped).toBeTruthy();
    const wrapped = Buffer.from(row!.wrapped as Buffer);
    expect(wrapped.includes(Buffer.from(token, 'utf8'))).toBe(false);
    expect(unwrapManageToken(wrapped, row!.digest)).toBe(token);
  });
});

describe('guest manage mutations for desk, phone_manual, and phone_ai', () => {
  const managePost = (body: object) => app.inject({
    method: 'POST',
    url: '/public/v1/hosted/manage',
    payload: body,
    headers: { origin: 'https://book.geniefront.com' },
  }) as unknown as Promise<Injected>;

  async function unwrapIssuedToken(appointmentId: string): Promise<string> {
    const [row] = await withTenant(tenant, (tx) => tx<{
      digest: string; wrapped: Buffer | Uint8Array | null;
    }[]>`
      select manage_token_digest as digest, manage_token_wrapped as wrapped
        from appointments where id = ${appointmentId}`);
    const token = unwrapManageToken(row?.wrapped, row!.digest);
    if (!token) throw new Error('expected a reconstructable manage token');
    return token;
  }

  async function createDeskLike(
    source: 'desk' | 'phone_manual',
  ): Promise<{ id: string; token: string; last4: string; slug: string; phone: string }> {
    const [cust] = await withTenant(tenant, (tx) => tx<{ id: string; phone: string }[]>`
      select id, phone_e164 as phone from customers
      where org_id = ${NAIL_ORG} and phone_e164 is not null
      order by id limit 1`);
    const out = await dispatch<{ appointmentId: string }>(
      'appointment.create',
      {
        customerId: cust!.id,
        items: [{ serviceId, addonIds: [], membershipId: null, startsAt: nextSlot(), details: {} }],
        partySize: 1,
        source,
      },
      ctx,
      { idempotencyKey: randomUUID() },
    );
    const id = out.result.appointmentId;
    const token = await unwrapIssuedToken(id);
    const [shop] = await withTenant(tenant, (tx) => tx<{ slug: string }[]>`
      select slug from locations where id = ${NAIL_LOC}`);
    return {
      id, token, last4: cust!.phone.slice(-4), slug: shop!.slug, phone: cust!.phone,
    };
  }

  afterEach(async () => {
    // Desk / phone_manual tests leave rows outside the web-only beforeAll cleanup.
    await withTenant(tenant, (tx) => tx`
      delete from appointments
      where location_id = ${NAIL_LOC}
        and source in ('desk', 'phone_manual', 'phone_ai')
        and business_date >= ${bookDate}
        and manage_token_digest is not null`);
  });

  it('desk appointment can bootstrap, cancel, and reschedule', async () => {
    const made = await createDeskLike('desk');
    const boot = await managePost({ slug: made.slug, manageToken: made.token });
    expect(boot.statusCode).toBe(200);
    expect(boot.json().booking.bookingId).toBe(made.id);
    expect(boot.json().booking.actions.canCancel).toBe(true);
    expect(boot.json().booking.actions.canReschedule).toBe(true);

    const moved = await post(`/public/v1/bookings/${made.id}/reschedule`, {
      manageToken: made.token, last4: made.last4, startsAt: nextSlot(),
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().status).toBe('booked');

    const cancelled = await post(`/public/v1/bookings/${made.id}/cancel`, {
      manageToken: made.token, last4: made.last4,
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().status).toBe('cancelled');
  });

  it('phone_manual appointment can bootstrap, cancel, and reschedule', async () => {
    const made = await createDeskLike('phone_manual');
    const boot = await managePost({ slug: made.slug, manageToken: made.token });
    expect(boot.statusCode).toBe(200);
    expect(boot.json().booking.bookingId).toBe(made.id);

    const moved = await post(`/public/v1/bookings/${made.id}/reschedule`, {
      manageToken: made.token, last4: made.last4, startsAt: nextSlot(),
    });
    expect(moved.statusCode).toBe(200);

    const cancelled = await post(`/public/v1/bookings/${made.id}/cancel`, {
      manageToken: made.token, last4: made.last4,
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().status).toBe('cancelled');
  });

  it('phone_ai appointment can bootstrap and cancel', async () => {
    const token = generateManageToken();
    const phone = `+1617333${String(Math.floor(Math.random() * 9000) + 1000)}`;
    const out = await dispatch<{ appointmentId: string }>(
      'appointment.create',
      {
        customerId: null,
        items: [{ serviceId, addonIds: [], membershipId: null, startsAt: nextSlot(), details: {} }],
        partySize: 1,
        source: 'phone_ai',
        guest: {
          confirmationCode: generateConfirmationCode('Lotus'),
          manageToken: token,
          customer: { name: 'Phone AI Guest', phoneE164: phone, smsOptIn: false },
        },
      },
      ctx,
      { idempotencyKey: randomUUID() },
    );
    const id = out.result.appointmentId;
    const boot = await managePost({ slug: 'lotus-nails', manageToken: token });
    expect(boot.statusCode).toBe(200);
    expect(boot.json().booking.bookingId).toBe(id);

    const cancelled = await post(`/public/v1/bookings/${id}/cancel`, {
      manageToken: token, last4: phone.slice(-4),
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().status).toBe('cancelled');
  });

  it('wrong token and wrong shop remain a generic 404 for desk bookings', async () => {
    const made = await createDeskLike('desk');
    const missing = await managePost({
      slug: made.slug, manageToken: generateManageToken(),
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().code).toBe('NOT_FOUND');
    expect(missing.json().details).toEqual({ entity: 'booking' });
    expect(JSON.stringify(missing.json())).not.toMatch(/mt_/);

    const cross = await managePost({ slug: 'golden-foot', manageToken: made.token });
    expect(cross.statusCode).toBe(404);
    expect(cross.json()).toEqual(missing.json());

    const wrongCancel = await post(`/public/v1/bookings/${made.id}/cancel`, {
      manageToken: generateManageToken(), last4: made.last4,
    });
    expect(wrongCancel.statusCode).toBe(404);
    expect(wrongCancel.json()).toMatchObject({ code: 'NOT_FOUND', details: { entity: 'booking' } });

    const [row] = await withTenant(tenant, (tx) => tx<{ status: string }[]>`
      select status from appointments where id = ${made.id}`);
    expect(row!.status).toBe('booked');
  });
});
