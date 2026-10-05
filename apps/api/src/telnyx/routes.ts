import { recordSmsDelivery } from '../sms/delivery';
import { getRecordingMetadata } from '../voice/provider';
import { recordingBoundary } from '../voice/directSip';
/**
 * Telnyx 的入口：三个 AI 工具 + 一个通话事件 webhook（09-TELNYX §4.2）
 *
 * 这几条路由和系统里所有别的路由有一个根本区别：**它们没有登录用户**。
 * 没有 Bearer token、没有 X-Membership-Id、没有会话 —— 身份证明只有一个
 * Ed25519 签名。所以这个文件里每一条路由都以同一件事开头：验签。
 *
 * 定位门店靠**被叫号码**：`phone_lines.e164 → location`。
 * 这是 webhook 里唯一能用来确定租户的东西，所以那张表的 e164 是全局唯一的。
 *
 * ⚠️ 写操作一律走命令总线（宪法第 1 条不为任何供应商破例）。
 * 这里只做：验签 → 定位门店 → 组一个系统上下文 → dispatch。
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  AppError, ERROR_CODES, pickText, normalizePhoneE164,
  type CommandContext, type Permission,
  VoiceBookingInput,SubmitVoiceBooking,
} from '@gf/contracts';
import {
  withTenant, tenantForPhoneNumber,
  setSmsConsent, recordInboundSms,
} from '@gf/db';
import { dispatch } from '../bus';
import { loadSlotContext, summariseSlots } from '../queries/slots';
import { addDays, wallMinuteToInstant, businessDateOf } from '@gf/scheduling';
import { verifyTelnyxSignature, SIGNATURE_HEADER, TIMESTAMP_HEADER } from './verify';
import { hashToolToken, sameDigest } from './toolToken';
import { rawBodyOf } from '../rawBody';
import { maybeAutoTopup, billingSystemContext } from '../billing/autoTopup';
import { classify } from '../sms/keywords';
import { flushSms } from '../sms/flush';
import { flushEmails } from '../email/flush';
import { generateManageToken } from '../public/bookingToken';
import {voiceDepositQuote,currentVoiceBooking} from '../voice/deposit';
import '../handlers/voiceBooking';
import '../handlers/phone';
import '../handlers/billing';

/**
 * AI 电话这个 actor 的全部权限。
 *
 * 只有一条写权限，而且写的是复核队列不是排期表 ——
 * 就算整个验签被绕过，攻击者也只能往前台的待办里塞垃圾。
 *
 * 特别注意**没有** `customer.view_contact`：AI 用号码查人，
 * 但不需要把完整号码念出来。少一个权限就少一条泄露路径。
 */
const PHONE_AI_PERMISSIONS: readonly Permission[] = [
  /**
   * ⭐ 2026-08-22：加了 `appointment.write`。
   *
   * 在此之前 AI 只能写复核队列，建单必须前台点确认（原决策 6）。
   * 店主明确改了这条：**AI 直接建单，客人挂电话就收到确认短信**，
   * 前台在「来电记录」里知悉即可。
   *
   * 这是本模块的第一次安全面扩大，配套约束见下面第 2、3 条。
   *
   * ⭐ **2026-08-25（批 3）：又加了 `appointment.cancel`。**
   *
   * 此前这里写的是「**只能建，不能改不能删**…建错一单可以补救，
   * 被静默改掉的单没人会发现」。店主明确要求 AI 能在电话里改期和取消，
   * 所以那一条被推翻了。但**那句顾虑本身是对的**，所以下面第 4 条是
   * 专门冲着它去的 —— 不是把它划掉了事。
   *
   *   1. **改期 / 取消受一整组老板可配的闸门约束**，见 §aiChangeGate。
   *      `locations.settings.ai_change.enabled` **默认 false** ——
   *      没进过那一页的店，AI 一律只能往复核队列里提请求。
   *   2. **永不传 override。** 软约束放行需要一个知道店里现在什么情况的人，
   *      电话那头没有这个人（同公开预约页的口径）。
   *   3. **时间只能来自 find_slots。** AI 报的每一个时段都必须是引擎返回的，
   *      book_appointment 会再校验一次 slot 是否仍然可用。
   *   4. ⭐ **「静默」那一半靠这三样堵**：每一次变更都是一条命令 →
   *      有审计（谁、什么时候、从哪个时间改到哪个时间）；前台的
   *      「☎️ 待复核」里能看到被拦下的请求和拦它的理由；
   *      而**客人侧的变更通知**留到批 7（通知模板）——
   *      ⚠️ 在批 7 落地之前，AI 改期/取消是**不会**通知客人的，
   *      给店家开这个开关时要说清楚这一点。
   *
   * 仍然**没有** `customer.view_contact`：AI 用号码查人，但念不出完整号码。
   */
  'appointment.write',
  'appointment.cancel',
  'call.draft',
  'appointment.read',
  'customer.read',
  'schedule.read',
];

/**
 * 开场白模板渲染。**纯字符串替换，不调模型。**
 *
 * `{{caller_name}}` 在这里**渲染不掉** —— 接起电话那一刻我们还不知道
 * 来电者叫什么（`lookup_customer` 是之后才跑的）。原样留给 Telnyx 那边，
 * 它拿得到通话上下文。留着比替换成空字符串好：至少 AI 看得出这里
 * 本该有个名字，而不是收到一句语法不通的话。
 */
function renderGreeting(
  template: string | null, storeName: string, assistantName: string | null,
): string {
  const dflt = assistantName
    ? `Thank you for calling ${storeName}! This is ${assistantName}, how can I help you today?`
    : `Thank you for calling ${storeName}! How can I help you today?`;
  if (!template) return dflt;
  return template
    .replaceAll('{{store_name}}', storeName)
    .replaceAll('{{assistant_name}}', assistantName ?? '');
}

interface Tenant {
  orgId: string;
  locationId: string;
  name: string;
  timezone: string;
  locale: string;
  /** 这条线的第二把钥匙（sql/0036）。null = 还没开这道门，照旧只验签名 */
  toolTokenDigest: string | null;
  assistantId: string | null;
}

/**
 * ⭐ 每个工具的返回里都带上「这是哪家店」。
 *
 * 入参里**没有** location id，是有意的：这几条路由没有登录用户，
 * 身份证明只有一个签名。一旦接受调用方给的门店 id，任何拿到（或伪造过）
 * 一次签名的人就能点名查任意一家店的客户和排期 —— 而被叫号码做不到这件事，
 * 它必须先在 `phone_lines` 里绑给某家店，且 `ai_voice` 的号全局唯一。
 *
 * 但「不接受」不等于「不告诉」：出参里说清楚落到了谁头上，
 * 否则调用方和看日志的人没有任何办法确认这通电话没有串店。
 * AI 也用得上 —— 它可以在电话里说出店名。
 */
const shopOf = (t: Tenant) => ({
  locationId: t.locationId,
  name: t.name,
  timezone: t.timezone,
});

/**
 * 组一个系统上下文。
 *
 * `membershipId: null` —— 电话背后**没有人**。硬塞一个真实 membership
 * 会让审计流水指向某位技师，而她什么都没做过。
 * `actorKind: 'api'` 把「这是机器干的」写进 audit_log。
 */
function systemContext(t: Tenant): CommandContext {
  return {
    orgId: t.orgId,
    locationId: t.locationId,
    userId: '00000000-0000-4000-8000-000000000000',
    membershipId: null,
    permissions: new Set(PHONE_AI_PERMISSIONS),
    actorKind: 'api',
    locale: (t.locale as CommandContext['locale']) ?? 'en',
    timezone: t.timezone,
  };
}

export function registerTelnyxRoutes(app: FastifyInstance): void {
  const publicKey = process.env['TELNYX_PUBLIC_KEY'];

  /**
   * 验签 + 解析 body。**顺序不能反**（09 §8）。
   *
   * 原始字节由 `registerRawBodyParser` 留住（`/v1/telnyx/` 在
   * RAW_BODY_PREFIXES 里）—— 验的必须是原文，反序列化再序列化会改字节。
   */
  function verified(req: { headers: Record<string, unknown>; body: unknown }): Record<string, unknown> {
    if (!publicKey) {
      // 没配公钥就等于这道门没关。宁可整条路不可用，也不能放行。
      throw new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE, {
        details: { reason: 'TELNYX_PUBLIC_KEY 未配置' },
      });
    }
    const raw = rawBodyOf(req);
    verifyTelnyxSignature({
      rawBody: raw,
      signatureB64: req.headers[SIGNATURE_HEADER] as string | undefined,
      timestamp: req.headers[TIMESTAMP_HEADER] as string | undefined,
      publicKeyB64: publicKey,
    });
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, { details: { reason: 'body 不是合法 JSON' } });
    }
  }

  /**
   * 被叫号码 → 门店。
   *
   * 走 `withPhoneLine` 的号码维度上下文（packages/db/src/phone.ts）——
   * 不绕过 RLS，策略只放行 e164 恰好相等的那一行。
   * 找不到就 404：**别把一通电话落到一个猜出来的租户上**。
   */
  async function tenantForNumber(e164: string | undefined): Promise<Tenant> {
    if (!e164) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { reason: 'missing_to_number' } });

    /*
     * ⚠️ 只吞「这个号码不合法」，**不吞数据库出错**。
     *
     * 原来这里是 `.catch(() => null)` —— 一律当成「查不到」。
     * 于是连不上库的时候，每个工具返回的都是
     * `number_not_bound_to_any_location`：看起来像号码没绑对，
     * 实际上是库挂了。真出这事的时候，人会先去翻 phone_lines 那张表。
     */
    const t = await tenantForPhoneNumber(e164).catch((e: unknown) => {
      if (e instanceof Error && /withPhoneLine/.test(e.message)) return null;   // 不是 E.164
      throw new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE, {
        details: { reason: 'phone_lookup_failed', e164 },
        cause: e instanceof Error ? e : undefined,
      });
    });
    if (!t) {
      throw new AppError(ERROR_CODES.NOT_FOUND, {
        details: { reason: 'number_not_bound_to_any_location', e164 },
      });
    }
    return {
      orgId: t.orgId,
      locationId: t.locationId,
      name: pickText(t.name, 'en'),
      timezone: t.timezone,
      locale: t.locale,
      toolTokenDigest: t.toolTokenDigest,
      assistantId: t.assistantId,
    };
  }

  /**
   * 工具路由专用：号码定位门店 **+ 第二把钥匙**（sql/0036）。
   *
   * ## 为什么门店 id 不是入参，而这个是
   *
   * 两者看起来都是「调用方给一串东西指认自己」，区别在于**猜不猜得到**：
   * 门店 id 或号码是公开信息（号码就印在店门口），一旦它能选定租户，
   * 验签被绕过的那一刻，攻击者就能逐个号码点名查任意一家店。
   * 这串 token 是 32 字节随机、只存摘要、只在生成时露一次面。
   *
   * ⚠️ 但它**不替代号码**：定位门店的仍然是 `to`。
   * `call.hangup` / `message.received` 那条路是 webhook 不是工具调用，
   * 带不了自定义参数 —— 所以那边只能靠号码，这个函数也不用在那儿。
   *
   * 没配 token 的线照旧只验签名：一次迁移不该让存量号码在半夜里停掉。
   */
  async function tenantForTool(body: Record<string, unknown>): Promise<Tenant> {
    const t = await tenantForNumber(str(body['to']));
    if (!t.toolTokenDigest) return t;

    const given = str(body['shop_token']);
    if (!given || !sameDigest(hashToolToken(given), t.toolTokenDigest)) {
      /*
       * 缺和错回同一个错。**但一定要写进日志** ——
       * 这个 401 最可能的成因不是攻击，是「换了 token 忘了同步到
       * Telnyx 的 assistant 配置」，而那家店的电话此刻是全哑的。
       * 日志里没有这一行的话，排查要从「客人说打不通」开始。
       */
      app.log.warn(
        { e164: str(body['to']), locationId: t.locationId, gaveToken: Boolean(given) },
        'telnyx tool: shop_token 不匹配 —— assistant 配置可能没同步',
      );
      throw new AppError(ERROR_CODES.UNAUTHENTICATED, {
        details: { reason: 'shop_token_invalid' },
      });
    }
    return t;
  }

  // ── 三个只读查询：`start_call` 和它们各自的工具共用同一份实现 ──────────
  //
  // ⭐ 2026-08-22：这三样东西在一通电话里**是静态的**（客人是谁、店里卖什么、
  // 谁在班），所以接通时一次抓完比分三次问快得多 —— 电话里每一次工具调用
  // 都是一秒多的静默，客人会以为断线了。合并成 `start_call`。
  //
  // ⚠️ **空档不在其中**：它取决于客人说的项目、时长、人数、哪一天，
  // 而且会在通话过程中被前台或官网订走。塞进开场那一坨里，模型会在
  // 五分钟后照着念一个已经没了的时段 —— 那正是这套设计要防的事。

  /** 来电号码 → 这个号下的客人（可能不止一位，决策 21） */
  async function loadCallers(t: Tenant, from: string | undefined): Promise<{
    guidance?: string;
    customers: Array<{
      customerId: string; displayName: string;
      lastVisitOn: string | null; lastService: string | null;
    }>;
  }> {
    if (!from) return { customers: [] };

    const digits = from.replace(/\D/g, '');
    const rows = await withTenant(
      { orgId: t.orgId, locationId: t.locationId, membershipId: null },
      (tx) => tx<{
        id: string; display_name: string; last_visit_on: string | null; last_service: string | null;
      }[]>`
        select c.id, c.display_name,
               (select max(a.business_date)::text from appointments a
                 where a.customer_id = c.id and a.status <> 'cancelled') as last_visit_on,
               (select ti.name_snapshot from tickets t
                  join ticket_items ti on ti.ticket_id = t.id
                 where t.customer_id = c.id order by t.opened_at desc limit 1) as last_service
        from customers c
        where c.merged_into_id is null
          and regexp_replace(coalesce(c.phone_e164,''), '\\D', '', 'g') like ${'%' + digits}
        order by c.display_name limit 5`);

    return {
      // AI 拿到 >1 条时必须开口问，这句话直接写在返回里，比藏在 prompt 里可靠
      ...(rows.length > 1
        ? {
            guidance: 'More than one customer is on this number. Ask who is speaking — '
              + 'never pick one for them.',
          }
        : {}),
      customers: rows.map((r) => ({
        customerId: r.id,
        displayName: r.display_name,
        lastVisitOn: r.last_visit_on,
        lastService: r.last_service,
      })),
    };
  }

  /** 价目表。主项目与加项分开（`is_addon`，sql/0035） */
  async function loadPriceList(t: Tenant, category: string | undefined): Promise<{
    services: PriceRow[]; addons: PriceRow[];
  }> {
    const rows = await withTenant(
      { orgId: t.orgId, locationId: t.locationId, membershipId: null },
      (tx) => tx<{
        id: string; name: unknown; description: unknown;
        duration_min: number; price_cents: number; category: unknown; is_addon: boolean;
      }[]>`
        select s.id, s.name, s.description, s.duration_min,
               s.base_price_cents as price_cents, sc.name as category, s.is_addon
        from services s
        left join service_categories sc on sc.id = s.category_id
        where s.location_id = ${t.locationId} and s.active = true
        order by sc.sort, s.sort, s.name->>'en'`);

    /*
     * ⚠️ 分类过滤在应用层做，不在 SQL 里。
     * `service_categories.name` 是多语言 jsonb，没有稳定的 key 列
     * （查过 schema，确实没有），所以只能取出来按显示名模糊匹配。
     * 匹配不上时**返回全部**而不是空列表 —— AI 拿到空列表会告诉客人
     * 「我们没有这类项目」，而实际上只是分类名对不上。
     */
    const shaped: PriceRow[] = rows.map((r) => ({
      serviceId: r.id,
      name: pickText(r.name, 'en'),
      description: r.description ? pickText(r.description, 'en') : null,
      durationMin: r.duration_min,
      priceCents: r.price_cents,
      category: r.category ? pickText(r.category, 'en') : null,
      isAddon: r.is_addon,
    }));
    const lower = category?.toLowerCase();
    const filtered = lower
      ? shaped.filter((x) => x.category?.toLowerCase().includes(lower))
      : shaped;
    const usable = filtered.length > 0 ? filtered : shaped;

    return {
      services: usable.filter((x) => !x.isAddon),
      addons: usable.filter((x) => x.isAddon),
    };
  }

  /** 可接客的技师。`onShift` 按给定日期算，不给就按今天 */
  async function loadTherapists(t: Tenant, opts: { gender?: string; date?: string }): Promise<Array<{
    membershipId: string; displayName: string; gender: string | null;
    skills: string[]; onShift: boolean;
  }>> {
    const gender = opts.gender ?? null;
    const onDate = opts.date ?? null;
    const rows = await withTenant(
      { orgId: t.orgId, locationId: t.locationId, membershipId: null },
      // ⚠️ `skills` 聚合出来的是 jsonb（技能名是多语言的），不是字符串
      (tx) => tx<{
        membership_id: string; name: unknown; gender: string | null;
        skills: unknown[] | null; on_shift: boolean;
      }[]>`
        select sp.membership_id, sp.display_name as name, sp.gender,
               array_remove(array_agg(sk.name), null) as skills,
               exists (
                 select 1 from shifts sh
                 where sh.membership_id = sp.membership_id
                   and sh.business_date = coalesce(${onDate}::date, current_date)
                   and sh.status <> 'off'
               ) as on_shift
        from staff_profiles sp
        join memberships m on m.id = sp.membership_id and m.status = 'active'
        left join staff_skills ss on ss.membership_id = sp.membership_id
        left join skills sk on sk.id = ss.skill_id
        where sp.location_id = ${t.locationId} and sp.is_bookable = true
          and (${gender}::text is null or sp.gender = ${gender})
        group by sp.membership_id, sp.display_name, sp.gender
        order by sp.display_name`);

    return rows.map((r) => ({
      membershipId: r.membership_id,
      displayName: pickText(r.name, 'en'),
      gender: r.gender,
      // 不转的话 AI 拿到的是 {"en":"Gel","zh-Hans":"甲油胶"} —— 它会照着念出来
      skills: (r.skills ?? []).map((k) => pickText(k, 'en')),
      onShift: r.on_shift,
    }));
  }

  // ── tool 0：接通那一下，一次抓完 ⭐ ──────────────────────────────────────
  //
  // 客人是谁、店里卖什么、今天谁在班、几点关门 —— 这四样在一通电话里
  // 都不会变，而分四次问就是四段静默。合并的另一个好处：
  // 「你们几点关门」「有没有女技师」这类问题**一次工具都不用调**就答得上来。
  app.post('/v1/telnyx/tools/start_call', async (req) => {
    const body = verified(req);
    const t = await tenantForTool(body);

    const [loc] = await withTenant(
      { orgId: t.orgId, locationId: t.locationId, membershipId: null },
      (tx) => tx<{ hours: Record<string, { open: string; close: string; periods?: Array<{open:string;close:string}> } | null>; cutoff: string }[]>`
        select business_hours as hours, business_day_cutoff::text as cutoff
        from locations where id = ${t.locationId}`);

    /*
     * ⭐ 转人工的号（`phone_lines.purpose = 'transfer_target'`，docs/09 §2）。
     *
     * 店家在「开店配置 → 电话」里填的那个号 —— 多数时候是老板的手机。
     * 没填就是 `available: false`：**这时候不许说「我帮您转接」**，
     * 而要说「我让前台回电给您」（走 request_callback）。
     * 说了转接却转不过去，客人听到的是一声忙音，然后这通电话就没了。
     */
    const [transferLine] = await withTenant(
      { orgId: t.orgId, locationId: t.locationId, membershipId: null },
      (tx) => tx<{ e164: string }[]>`
        select e164 from phone_lines
        where location_id = ${t.locationId} and purpose = 'transfer_target' and active
        limit 1`);

    const businessDate = businessDateOf(new Date(), t.timezone, loc?.cutoff ?? '04:00');

    /*
     * ⭐ 开场白（批 3）。老板在后台配三样东西：助手名、开场白、
     * 以及「让不让 AI 自己生成欢迎语」。
     *
     * ⚠️ **这里不调模型。** 生成欢迎语交给 Telnyx 那边的 assistant ——
     * 我们只把「原料」和「怎么用」告诉它。理由是这段话要在客人
     * 拿起电话的**第一秒**说出口，多一次我们这边的模型往返就是
     * 一秒半的静默，而静默的那一秒客人会以为没接通。
     */
    const [line] = await withTenant(
      { orgId: t.orgId, locationId: t.locationId, membershipId: null },
      (tx) => tx<{
        assistant_name: string | null; greeting_template: string | null;
        greeting_ai_generated: boolean; ai_answer: boolean;
        tool_token_digest: string | null;
      }[]>`
        select assistant_name, greeting_template, greeting_ai_generated, ai_answer,
               tool_token_digest
        from phone_lines
        where location_id = ${t.locationId} and purpose = 'ai_voice' and active
        limit 1`);
    const [callers, price, staff] = await Promise.all([
      loadCallers(t, str(body['from'])),
      loadPriceList(t, undefined),
      loadTherapists(t, { date: businessDate }),
    ]);

    return {
      shop: shopOf(t),
      businessDate,
      /** 一周的营业时间。「你们周日开吗」是电话里最高频的问题之一 */
      businessHours: loc?.hours ?? null,
      /**
       * 这一坨 guidance 是四个工具那几句的合并版。
       * 写在返回里而不是 prompt 里的理由没变：它跟着数据一起到，
       * 而且能随数据变化（同号多客户那句只在真有多位时出现）。
       */
      guidance: 'Everything here is background for this call and can be said to the caller. '
        // ⭐ 店主 2026-08-23 实测后的要求：一上来别报价目表。
        // 「有什么按摩」→ 先说有哪几样，等客人挑了、说了想做多久，再报那一个的价
        + 'When they ask what you offer, NAME a few services only — no prices and no durations. '
        + 'Then ask which one they want and how long, and quote the price for that one choice. '
        + 'Do not read the list out like a menu. '
        + 'Quote only what is listed here; never invent discounts or package prices — '
        + 'if they push for a deal, say the front desk will look at it and call them back. '
        + (price.addons.length > 0
          ? 'Items in `addons` are ADD-ONS: they go on top of a main service and cannot be '
            + 'booked alone, so say "plus $15", never "$15 for a session". '
          : '')
        + 'Mention a therapist\'s gender only if the caller raises it, and never read out a '
        + 'therapist\'s phone number or full name. '
        + (transferLine?.e164
          ? 'If they ask for a person, or you cannot help, you may transfer the call. '
          : 'There is no human line to transfer to — never say you will transfer. '
            + 'Offer a call back from the front desk instead (request_callback). ')
        + 'When the caller is done and has nothing else to ask, say goodbye and hang up — '
        + 'do not sit on an open line. '
        + '⚠️ There are NO appointment times here on purpose — open slots get taken during the '
        + 'call. Every time you say out loud must come from find_slots.',
      /** 来电号码下的客人。空数组 = 新客 */
      caller: callers,
      currency: 'USD',
      /** ⚠️ 价格是整数分（宪法第 4 条）。AI 自己格式化成 $45.00 */
      services: price.services,
      addons: price.addons,
      /** ⚠️ 只有显示名、性别、技能、今天在不在班 —— 没有手机号和全名 */
      staff,
      /**
       * ⭐ 转人工。Telnyx 的 `transfer` 是**内置工具**，号码配在 assistant 上；
       * 这里返回它是为了让 AI 知道**能不能说「我帮您转接」**。
       *
       * `available: false` 时不许提转接 —— 说了转不过去，客人听到的是忙音。
       * 那种情况走 `request_callback`（前台回电）。
       */
      transfer: {
        available: Boolean(transferLine?.e164),
        e164: transferLine?.e164 ?? null,
      },
      /**
       * 开场白（批 3）。三种情况，AI 按 `mode` 决定怎么用 `text`：
       *
       *   `verbatim`  —— 老板写了逐字稿，**一字不改地念**
       *   `generate`  —— 老板开了「AI 生成」，`text` 是**语气参考**：
       *                  按这个调子自己组织，可以带上时段和「是不是老客」
       *   `default`   —— 老板什么都没配，用下面这句
       *
       * ⚠️ `aiAnswer = false` 时整个 AI 应答该关掉 —— 这是老板的
       * 日常开关（今天人手够 / AI 说错话了先关掉），和「这号不属于本店」
       * （`active = false`）不是一回事。
       */
      greeting: {
        // ⚠️ fail closed：查不到 active 的 ai_voice 线（线路没配好 / 被停用），
        // 或工具 token 还没铸好（本地未就绪），一律按「不接」返回，不回填 true。
        // 绑号 ≠ 就绪 ≠ 开启接听（U08 / S4，sql/0113）。
        aiAnswer: Boolean(line?.ai_answer && line?.tool_token_digest),
        assistantName: line?.assistant_name || null,
        mode: line?.greeting_ai_generated
          ? 'generate'
          : (line?.greeting_template ? 'verbatim' : 'default'),
        text: renderGreeting(
          line?.greeting_template || null, t.name, line?.assistant_name || null),
      },
    };
  });

  // ── tool 1：查老客（只读）────────────────────────────────────────────────
  //
  // 决策 21：同号多客户（夫妻/母女共号）必须返回列表让 AI 在电话里问
  // 「请问是哪位」，**不许自动挑一个**。挑错了整通电话会挂到另一个人头上。
  //
  // ⚠️ `start_call` 已经把它包含在内了。这条路留着是因为 Telnyx 那边的
  // 配置是人工推的 —— 一次合并不该让还没更新配置的店打不通电话。
  app.post('/v1/telnyx/tools/lookup_customer', async (req) => {
    const body = verified(req);
    const t = await tenantForTool(body);
    return { shop: shopOf(t), ...await loadCallers(t, str(body['from'])) };
  });

  // ── tool 2：查真实空档（只读）───────────────────────────────────────────
  //
  // ⭐ 这是 09 §8「不让 AI 自己算空档」那条护栏的正面实现。
  // AI 在电话里报的每一个时间都必须来自这个接口。
  //
  // 四个入参是 2026-08-22 补齐的（docs/14 §4 那张「尚未实现」表）：
  //   party_size        几位一起来 —— 同一时刻要凑得齐这么多位技师
  //   services[]        多项目连做 —— 时长是各项之和，先只支持同一技师连做
  //   gender_preference 收窄成候选技师集**传给引擎**，不是拿到结果再过滤
  //   alternatives      那天没空档时往后找三天，并在 guidance 里写明这是改期建议
  app.post('/v1/telnyx/tools/find_slots', async (req) => {
    const body = verified(req);
    const t = await tenantForTool(body);

    const around = str(body['around']) ? new Date(str(body['around'])!) : new Date();
    if (Number.isNaN(around.getTime())) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, { details: { reason: 'bad_around' } });
    }
    const preferred = str(body['staff_membership_id']) ?? null;

    /*
     * 时长以**库里的项目**为准，不以 AI 传的 duration_min 为准。
     *
     * 模型会把「洗剪吹」估成 30 分钟而店里那一项是 60。按它估的找空档，
     * 找到的位置放不下这一单 —— 建单时不会报错（时长是建单时重新算的），
     * 出事的是后面那位客人：他被排在一个已经被占掉的时间上。
     *
     * 一个项目都没匹配上时才退回 duration_min（再退到 45 分钟）。
     */
    const heard = strArray(body['services']) ?? listOf(str(body['service_heard']));
    const { matched, unmatched } = heard.length > 0
      ? await resolveHeardServices(t, heard)
      : { matched: [] as CatalogItem[], unmatched: [] as string[] };

    const durationMin = matched.length > 0
      ? matched.reduce((n, m) => n + m.durationMin, 0)
      : num(body['duration_min']) ?? 45;

    const partySize = clampInt(num(body['party_size']) ?? 1, 1, 20);
    const depositQuote=matched.length?await withTenant(systemContext(t),tx=>voiceDepositQuote(tx,t.locationId,matched.reduce((n,m)=>n+m.priceCents,0)*partySize)):null;
    const genderPreference = normGender(str(body['gender_preference']));
    const opts = { genderPreference, partySize };

    const found = await withTenant(
      { orgId: t.orgId, locationId: t.locationId, membershipId: null },
      async (tx) => {
        const day = await loadSlotContext(tx, t.locationId, around, durationMin, preferred, opts);
        const top = summariseSlots(day.slots, minutesOf(around, day.timezone), 3);
        if (top.length > 0 || !day.businessDate) {
          return { ...day, top, alternatives: [] as Alternative[] };
        }

        /*
         * 那一天没有空档 → 往后找三天。
         *
         * ⚠️ 这些时间**不是客人要的那一天**，所以它们不能出现在 `slots` 里。
         * 混在一起报出去，客人听到的是「周六下午三点可以」，
         * 而那是下周三 —— 他会照着周六来。分开放，并在 guidance 里写死措辞。
         */
        const alternatives: Alternative[] = [];
        for (let i = 1; i <= 3; i++) {
          const date = addDays(day.businessDate, i);
          // 正午作锚点：cutoff 最晚也就凌晨几点，正午永远落在同一个营业日
          const noon = wallMinuteToInstant(date, day.timezone, 12 * 60);
          const alt = await loadSlotContext(tx, t.locationId, noon, durationMin, preferred, opts);
          const altTop = summariseSlots(alt.slots, undefined, 2);
          if (altTop.length > 0) {
            alternatives.push({
              businessDate: alt.businessDate,
              /** 「换下周三行吗」—— 报得出日子，客人才知道是哪天 */
              dateLabel: spokenDate(alt.businessDate, alt.timezone),
              slots: altTop.map((x) => ({
                startsAt: x.startsAt.toISOString(),
                ...spokenTime(x.startsAt, alt.timezone),
                staff: x.staff.map((p) => p.name).join(' / '),
              })),
            });
          }
        }
        return { ...day, top, alternatives };
      });

    return {
      shop: shopOf(t),
      businessDate: found.businessDate,
      timezone: found.timezone,
      /** ⭐ 建单时把这个原样传回 `book_appointment`，两边的时长必须是同一个 */
      durationMin,
      partySize,
      ...(depositQuote?{deposit:depositQuote}:{}),
      /** 匹配上的项目。AI 复述给客人听的应该是这里的名字，不是它自己听到的 */
      services: matched.map((m) => ({
        serviceId: m.id, name: m.name, durationMin: m.durationMin,
        priceCents: m.priceCents, isAddon: m.isAddon,
      })),
      guidance: slotsGuidance({
        hasSlots: found.top.length > 0,
        alternatives: found.alternatives,
        partySize,
        genderPreference,
        unmatched,
      }),
      slots: found.top.map((s) => ({
        /** ⚠️ 建单时原样回传给 `book_appointment`。**不要念它**，它是 UTC */
        startsAt: s.startsAt.toISOString(),
        /** 念这个（门店当地时间） */
        ...spokenTime(s.startsAt, found.timezone),
        staff: s.staff,
      })),
      // 有空档时不出现 —— 免得模型从这里挑一个时间报出去
      ...(found.alternatives.length > 0 ? { alternatives: found.alternatives } : {}),
    };
  });

  // ── tool 3：放进复核队列（写）───────────────────────────────────────────
  /**
   * ⭐ 2026-08-22 改名 draft_appointment → request_callback，职责也变了。
   *
   * 以前它是**唯一**出口：AI 只能留草案，前台确认后才建单。
   * 现在 AI 直接建单（见 book_appointment），这条退化成**兜底** ——
   * 信息不全、没空档、或 book 失败且不该重试时，把已知的留给前台回电。
   *
   * 旧路径保留：Telnyx 那边的 assistant 配置是人工同步的，
   * 万一没改到，旧名还能工作。一次改名不该让电话打不通。
   */
  const requestCallback = async (req: FastifyRequest) => {
    const body = verified(req);
    const t = await tenantForTool(body);
    const ctx = systemContext(t);

    // 幂等键用 Telnyx 的 call id：通话重连、webhook 重投都会重放，
    // 不去重前台会看到两条一模一样的待办，而她分不清是客人打了两次还是系统重了
    const callId = str(body['call_session_id']) ?? str(body['call_control_id']);

    const out = await dispatch<{ draftId: string; queuedAt: string }>(
      'call.draftAppointment',
      {
        providerCallId: callId,
        fromE164: str(body['from']),
        serviceNameHeard: str(body['service_heard']),
        serviceId: await matchService(t, str(body['service_heard'])),
        staffNameHeard: str(body['staff_heard']),
        staffMembershipId: await matchStaff(t, str(body['staff_heard'])),
        timeHeard: str(body['time_heard']),
        slotStartsAt: str(body['slot_starts_at']) ?? null,
        durationMin: num(body['duration_min']) ?? null,
        callerNameHeard: str(body['caller_name']),
        confidenceBp: num(body['confidence_bp']) ?? 10000,
        notes: str(body['notes']),
      },
      ctx,
      { idempotencyKey: callId ? `telnyx-draft-${callId}` : crypto.randomUUID() , systemOrigin: 'telnyx_call' });

    return {
      ok: true,
      shop: shopOf(t),
      draftId: out.result.draftId,
      // AI 要在电话里说的那句话 —— 措辞在这里定死，
      // 否则模型会说成「已经帮您约好了」，而它其实只是放进了待办
      say: "I've taken that down. The front desk will call you back to confirm — "
        + 'usually within a few minutes.',
      guidance: 'This did NOT create an appointment. Say the front desk will call back; '
        + 'never say it is booked.',
    };
  };

  // ─────────────────────────── 改期 / 取消（批 3，docs/09 §5）────────────
  //
  // ## ⭐ 为什么这三条的闸门比建单严得多
  //
  // AI 建错单只是「往前台的待办里塞垃圾」—— 前台看一眼就删了。
  // AI **取消**错单是**把真实的生意删掉**：那一格没人用、钱收不到、
  // 技师白等，而客人下午照常出现在门口。两件事不能用同一套宽松度。
  //
  // ## 条件全部由老板设，代码里不写死
  //
  // 一家两个技师的小店和一家二十人的店，对「AI 自作主张取消一单」的
  // 容忍度差一个数量级。判据读 `locations.settings.ai_change`
  // （`location.saveAiChangePolicy` 写），**默认 enabled = false** ——
  // 没进过那一页的店，AI 一律只能提请求。

  interface AiChangePolicy {
    enabled: boolean;
    allowReschedule: boolean;
    allowCancel: boolean;
    requireExactCaller: boolean;
    requireSingleUpcoming: boolean;
    minHoursAhead: number;
    blockGroup: boolean;
    blockSameDay: boolean;
  }

  /** 读策略。缺字段一律按**最保守**的那一边兜底 */
  async function aiChangePolicy(t: Tenant): Promise<AiChangePolicy> {
    const [loc] = await withTenant(
      { orgId: t.orgId, locationId: t.locationId, membershipId: null },
      (tx) => tx<{ settings: Record<string, unknown> }[]>`
        select settings from locations where id = ${t.locationId}`);
    const raw = ((loc?.settings ?? {})['ai_change'] ?? {}) as Record<string, unknown>;
    const bool = (v: unknown, dflt: boolean) => (typeof v === 'boolean' ? v : dflt);
    const int = (v: unknown, dflt: number) =>
      (typeof v === 'number' && Number.isFinite(v) ? v : dflt);
    return {
      enabled: bool(raw['enabled'], false),
      allowReschedule: bool(raw['allow_reschedule'], true),
      allowCancel: bool(raw['allow_cancel'], false),
      requireExactCaller: bool(raw['require_exact_caller'], true),
      requireSingleUpcoming: bool(raw['require_single_upcoming'], true),
      minHoursAhead: int(raw['min_hours_ahead'], 24),
      blockGroup: bool(raw['block_group'], true),
      blockSameDay: bool(raw['block_same_day'], true),
    };
  }

  interface UpcomingRow {
    id: string; starts_at: string; business_date: string;
    phone: string | null; group_id: string | null;
    service_name: unknown; staff_name: unknown;
  }

  /** 这个来电号码名下、将来还没开始的单（最早的在前） */
  async function upcomingFor(t: Tenant, fromE164: string): Promise<UpcomingRow[]> {
    return withTenant(
      { orgId: t.orgId, locationId: t.locationId, membershipId: null },
      (tx) => tx<UpcomingRow[]>`
        select distinct on (a.id)
               a.id, a.starts_at::text as starts_at, a.business_date::text as business_date,
               c.phone_e164 as phone, tg.id as group_id,
               s.name as service_name, sp.display_name as staff_name
        from appointments a
        join customers c on c.id = a.customer_id
        left join appointment_items ai on ai.appointment_id = a.id and ai.status <> 'cancelled'
        left join services s on s.id = ai.service_id
        left join staff_profiles sp on sp.membership_id = ai.membership_id
        left join tickets tk on tk.appointment_id = a.id and tk.status <> 'voided'
        left join ticket_groups tg on tg.id = tk.group_id
        where a.location_id = ${t.locationId}
          and c.phone_e164 = ${fromE164}
          and a.status not in ('cancelled', 'completed')
          and a.starts_at > now()
        order by a.id, a.starts_at`);
  }

  /**
   * 判断这次能不能让 AI 直接动手。
   *
   * 返回 `null` = 放行；返回一个字符串 = 拦下的原因，调用方据此落队列。
   * **顺序是从"最不可能放行"到"最可能"**，这样 gate_reason 报的是
   * 最根本的那条原因，而不是碰巧先撞上的那条。
   */
  function aiChangeGate(
    p: AiChangePolicy, kind: 'reschedule' | 'cancel',
    appt: UpcomingRow, upcomingCount: number, fromE164: string, todayBusinessDate: string,
  ): string | null {
    if (!p.enabled) return 'disabled';
    if (kind === 'reschedule' && !p.allowReschedule) return 'not_allowed';
    if (kind === 'cancel' && !p.allowCancel) return 'not_allowed';

    // ⚠️ 不做模糊匹配、不做姓名匹配。号码不等就是不等 ——
    // 「听起来像本人」不是身份证明
    if (p.requireExactCaller && appt.phone !== fromE164) return 'caller_mismatch';
    if (p.requireSingleUpcoming && upcomingCount > 1) return 'multiple_upcoming';
    if (p.blockSameDay && appt.business_date === todayBusinessDate) return 'same_day';
    if (p.blockGroup && appt.group_id) return 'group_ticket';

    if (p.minHoursAhead > 0) {
      const hours = (new Date(appt.starts_at).getTime() - Date.now()) / 3600_000;
      if (hours < p.minHoursAhead) return 'too_soon';
    }
    return null;
  }

  /** 落一条变更请求进复核队列，并给 AI 一句能直接说出口的话 */
  async function queueChange(
    t: Tenant, ctx: CommandContext, body: Record<string, unknown>,
    kind: 'reschedule' | 'cancel', targetId: string | null, gateReason: string,
  ) {
    const callId = str(body['call_session_id']) ?? str(body['call_control_id']);
    const out = await dispatch<{ draftId: string }>('call.draftAppointment', {
      providerCallId: callId,
      fromE164: str(body['from']),
      kind,
      targetAppointmentId: targetId,
      requestedText: str(body['requested_text']) ?? str(body['time_heard']) ?? null,
      timeHeard: str(body['time_heard']),
      slotStartsAt: str(body['slot_starts_at']) ?? null,
      callerNameHeard: str(body['caller_name']),
      gateReason,
      notes: str(body['notes']),
      confidenceBp: num(body['confidence_bp']) ?? 10000,
    }, ctx, { ...({
      idempotencyKey: callId
        ? `telnyx-${kind}-${callId}` : crypto.randomUUID(),
    }), systemOrigin: 'telnyx_call' });

    return {
      ok: true,
      applied: false,
      draftId: out.result.draftId,
      gateReason,
      // ⚠️ 措辞在这里定死。让模型自己组织的话，它会说成
      // 「已经帮您取消了」—— 而那一单还好好地在日程表上
      say: kind === 'cancel'
        ? "I've passed that on to the front desk. They'll call you right back to confirm the "
          + "cancellation — your appointment is still on until they do."
        : "I've passed that on to the front desk. They'll call you right back to confirm the new "
          + 'time — your original appointment is still on until they do.',
      guidance: 'This did NOT change anything. Say the front desk will call back to confirm; '
        + 'never say it is cancelled or moved.',
    };
  }

  // ── tool：找到「你的那一单」（只读）─────────────────────────────────────
  app.post('/v1/telnyx/tools/find_my_appointment', async (req) => {
    const body = verified(req);
    const t = await tenantForTool(body);
    const from = str(body['from']);
    if (!from) {
      return {
        ok: false, appointments: [],
        say: "I couldn't see the number you're calling from. Let me have the front desk call you back.",
        guidance: 'Call request_callback.',
      };
    }

    const rows = await upcomingFor(t, from);
    return {
      ok: true,
      shop: shopOf(t),
      appointments: rows.map((r) => ({
        appointmentId: r.id,
        startsAt: r.starts_at,
        serviceName: r.service_name ? pickText(r.service_name, 'en') : null,
        staffName: r.staff_name ? pickText(r.staff_name, 'en') : null,
      })),
      /**
       * ⚠️ 名下多于一单时**必须让 AI 在电话里问是哪一个**。
       * 替他挑一个的后果是改错单 —— 而客人要到当天才发现。
       */
      guidance: rows.length > 1
        ? 'They have more than one upcoming appointment. Read them back and ask which one '
          + 'before calling reschedule_appointment or cancel_appointment.'
        : rows.length === 1
          ? 'Exactly one upcoming appointment. Confirm it back to them before changing anything.'
          : 'No upcoming appointment on this number. Do not guess — offer to book a new one.',
    };
  });

  // ── tool：改期 ──────────────────────────────────────────────────────────
  app.post('/v1/telnyx/tools/reschedule_appointment', async (req) => {
    const body = verified(req);
    const t = await tenantForTool(body);
    const ctx = systemContext(t);
    return changeTool(t, ctx, body, 'reschedule');
  });

  // ── tool：取消 ──────────────────────────────────────────────────────────
  app.post('/v1/telnyx/tools/cancel_appointment', async (req) => {
    const body = verified(req);
    const t = await tenantForTool(body);
    const ctx = systemContext(t);
    return changeTool(t, ctx, body, 'cancel');
  });

  async function changeTool(
    t: Tenant, ctx: CommandContext, body: Record<string, unknown>,
    kind: 'reschedule' | 'cancel',
  ) {
    const from = str(body['from']);
    const targetId = str(body['appointment_id']) ?? null;
    const newStart = str(body['slot_starts_at']);

    if (!from) return queueChange(t, ctx, body, kind, targetId, 'caller_mismatch');
    if (kind === 'reschedule' && !newStart) {
      return {
        ok: false, applied: false,
        say: 'What day and time would work better for you?',
        guidance: 'Call find_slots first, then reschedule_appointment with slot_starts_at.',
      };
    }

    const upcoming = await upcomingFor(t, from);
    // AI 给了 id 就用它，没给且名下只有一单就用那一单 ——
    // ⚠️ 名下多于一单且没给 id 时**绝不替他挑**，直接落队列
    const appt = targetId
      ? upcoming.find((r) => r.id === targetId) ?? null
      : (upcoming.length === 1 ? upcoming[0]! : null);

    if (!appt) {
      return queueChange(t, ctx, body, kind, targetId,
        upcoming.length > 1 ? 'multiple_upcoming' : 'not_found');
    }

    const p = await aiChangePolicy(t);
    const [loc] = await withTenant(
      { orgId: t.orgId, locationId: t.locationId, membershipId: null },
      (tx) => tx<{ tz: string; cutoff: string }[]>`
        select timezone as tz, business_day_cutoff::text as cutoff
        from locations where id = ${t.locationId}`);
    const today = businessDateOf(new Date(), loc?.tz ?? 'UTC', loc?.cutoff ?? '04:00');

    const blocked = aiChangeGate(p, kind, appt, upcoming.length, from, today);
    if (blocked) return queueChange(t, ctx, body, kind, appt.id, blocked);

    // ── 闸门全过 → 真的执行 ────────────────────────────────────────────
    try {
      if (kind === 'cancel') {
        await dispatch('appointment.cancel', {
          appointmentId: appt.id,
          reason: 'guest_changed_mind',
          // 离开始还有 minHoursAhead 小时，技师根本没碰这一单（同公开入口）
          keepStaffTurn: false,
        }, ctx);
        return {
          ok: true, applied: true, appointmentId: appt.id,
          say: "All set — I've cancelled that for you. You'll get a confirmation shortly.",
          guidance: 'The appointment IS cancelled. Do not also call request_callback.',
        };
      }

      await dispatch('appointment.reschedule', {
        appointmentId: appt.id, startsAt: newStart!,
      }, ctx);
      return {
        ok: true, applied: true, appointmentId: appt.id, startsAt: newStart,
        say: "All set — I've moved your appointment. You'll get a confirmation shortly.",
        guidance: 'The appointment IS moved. Do not also call request_callback.',
      };
    } catch (e) {
      /*
       * ⚠️ 执行失败**不要把错误抛给模型** —— 它会在电话里说
       * 「系统出错了」，客人听到的是这家店不靠谱。
       * 落一条队列，让前台回电，AI 说的还是那句「已转前台」。
       */
      app.log.warn({ err: e, kind, appointmentId: appt.id }, 'ai change failed, queued instead');
      return queueChange(t, ctx, body, kind, appt.id, 'execute_failed');
    }
  }

  app.post('/v1/telnyx/tools/request_callback', requestCallback);
  app.post('/v1/telnyx/tools/draft_appointment', requestCallback);

  // ── tool 4：报项目和价格（只读）─────────────────────────────────────────
  //
  // ⚠️ `start_call` 已经把整张价目表给了。这条留着有两个用处：
  //   · Telnyx 那边配置没更新的店（人工同步）
  //   · 项目特别多的店：`category` 能只取一类，比整张表短得多
  app.post('/v1/telnyx/tools/list_services', async (req) => {
    const body = verified(req);
    const t = await tenantForTool(body);
    const { services, addons } = await loadPriceList(t, str(body['category']));

    return {
      shop: shopOf(t),
      /*
       * 报价话术写死在返回里而不是 prompt 里 —— 模型很容易顺着客人
       * 「能便宜点吗」往下接，而折扣不是它能决定的事。
       */
      guidance: 'Name the services when asked what you offer — no prices or durations until '
        + 'the caller has picked one and said how long. Quote only what is listed here; '
        + 'never invent discounts or package prices — if they push for a deal, say the front '
        + 'desk will look at it and call them back. '
        + (addons.length > 0
          ? 'Items in `addons` are ADD-ONS: they go on top of a main service and cannot be '
            + 'booked alone, so say "plus $15", never "$15 for a session".'
          : ''),
      /** ⚠️ 价格是整数分（宪法第 4 条）。AI 自己格式化成 $45.00 */
      currency: 'USD',
      services,
      addons,
    };
  });

  // ── tool 5：报技师（只读）───────────────────────────────────────────────
  //
  // 「你们有女技师吗」「Mai 今天在吗」这类问题。
  // ⚠️ `start_call` 给的是**今天**的在班情况；问别的日子才需要这条。
  app.post('/v1/telnyx/tools/list_staff', async (req) => {
    const body = verified(req);
    const t = await tenantForTool(body);
    const therapists = await loadTherapists(t, {
      ...(str(body['gender']) ? { gender: str(body['gender'])! } : {}),
      ...(str(body['date']) ? { date: str(body['date'])! } : {}),
    });

    return {
      shop: shopOf(t),
      /*
       * ⚠️ 性别只用于筛选，不主动播报。
       * 「要女技师」在这一行是真实且高频的诉求，所以字段存在；
       * 但没被问到时提起技师性别，在部分司法辖区是有风险的。
       */
      guidance: 'Mention a therapist\'s gender only if the caller raises it. Never read out a '
        + 'therapist\'s phone number or full name. If the person they asked for is not in that '
        + 'day, say which day they are in, or offer someone else who does that service.',
      therapists,
    };
  });

  // ── tool 6：真建预约（写）⭐ ────────────────────────────────────────────
  //
  // 2026-08-22 前这里是 draft_appointment（只进复核队列）。店主改了决策：
  // **AI 直接建单，客人挂电话就收到确认短信**，前台在来电记录里知悉。
  //
  // 三条约束（见 PHONE_AI_PERMISSIONS 上方那段）：只能建不能改删、
  // 永不传 override、时间必须来自 find_slots。
  app.post('/v1/telnyx/tools/book_appointment', async (req) => {
    const body = verified(req);
    const t = await tenantForTool(body);
    const ctx = systemContext(t);

    const startsAt = str(body['slot_starts_at']);
    const callerName = str(body['caller_name'])?.trim();
    const fromE164 = str(body['from']);

    /*
     * 项目：`services` 数组（多项目连做）优先，退回单个 `service_heard`。
     * 加项从同一个数组里按 `is_addon` 分出来 —— 客人在电话里说
     * 「六十分钟深层，加个热石」，这是一个主项目 + 一个加项，不是两个项目。
     */
    const heard = strArray(body['services']) ?? listOf(str(body['service_heard']));
    const { matched } = heard.length > 0
      ? await resolveHeardServices(t, heard)
      : { matched: [] as CatalogItem[] };
    const mains = matched.filter((m) => !m.isAddon);
    const addons = matched.filter((m) => m.isAddon);

    /*
     * 缺件时**不建单**，退回一句 AI 能直接说出口的话。
     * 让它自己编一个时间或名字，比不建单糟得多。
     */
    const missing: string[] = [];
    if (mains.length === 0) missing.push('service');
    if (!startsAt) missing.push('slot_starts_at');
    if (!callerName) missing.push('caller_name');
    if (!fromE164) missing.push('phone');
    if (missing.length > 0) {
      // 只听到加项是一种特别常见的缺件（「我要加个热石」），
      // 值得给 AI 一句能直接问出口的话，而不是笼统的「信息不全」
      const addonOnly = mains.length === 0 && addons.length > 0;
      return {
        ok: false,
        missing,
        say: addonOnly
          ? `${addons[0]!.name} goes on top of another service — what would you like to have done?`
          : "I'm sorry, I'm missing something I need to book this. Let me take your details and "
            + 'have the front desk call you right back.',
        guidance: addonOnly
          ? 'They named only an add-on. Ask which main service they want, then call find_slots '
            + 'and book_appointment again.'
          : 'Do not retry book_appointment. Call request_callback with whatever you already know.',
      };
    }

    // 时长以库里的项目为准（同 find_slots），一个都没匹配上才用 AI 估的
    const totalMin = matched.reduce((n, m) => n + m.durationMin, 0)
      || num(body['duration_min']) || 45;
    const partySize = clampInt(num(body['party_size']) ?? 1, 1, 20);
    const depositQuote=await withTenant(ctx,tx=>voiceDepositQuote(tx,ctx.locationId,matched.reduce((n,m)=>n+m.priceCents,0)*partySize));
    const consent=VoiceBookingInput.shape.depositConsent.safeParse(body['depositConsent']);
    if(depositQuote&&(!consent.success||!consent.data))return {
      ok:false,error:'deposit_confirmation_required',deposit:depositQuote,
      say:`This appointment requires a ${new Intl.NumberFormat('en-US',{style:'currency',currency:depositQuote.currency}).format(depositQuote.amountCents/100)} deposit. `
        +'We hold the time for 15 minutes, and payment confirms the appointment.',
      guidance:'Explain the returned deposit and cancellation policy and obtain explicit agreement. Then send depositConsent with accepted:true and the returned policyVersion, serviceTotalCents and amountCents. Ask for an email for payment instructions, or offer frontdesk assistance. Do not say the appointment is confirmed.',
    };
    const staffId = await matchStaff(t, str(body['staff_heard']));

    /*
     * ⭐ 两位客人一起来 = 两条并排的单，各占一位技师。
     *
     * 只把 `party_size: 2` 记在预约头上、底下仍然只有一条 item 的话，
     * 日程表上只占掉一个人 —— 前台看到的是「一位客人」，
     * 到店来了两位，而第二位没有技师。这里在建单前把人凑齐。
     */
    const staffIds = partySize > 1
      ? await pickPartyStaff(t, {
          startsAt: startsAt!, durationMin: totalMin, partySize,
          preferred: staffId, genderPreference: normGender(str(body['gender_preference'])),
        })
      : [staffId];

    if (staffIds.length < partySize) {
      return {
        ok: false,
        error: 'RESOURCE_CONFLICT',
        say: `I'm sorry — we no longer have ${partySize} therapists free at that time. `
          + 'Let me find you another time.',
        guidance: 'Call find_slots again (with party_size), then book_appointment with the new time.',
      };
    }

    // 幂等键用 Telnyx 的 call id：通话重连、webhook 重投都会重放。
    // 不去重的话客人会收到两条确认短信，而店里多了一个不存在的预约
    const callId = str(body['call_session_id']) ?? str(body['call_control_id']);

    const manageToken = generateManageToken();

    /*
     * 多项目连做：同一位技师，一段接一段。
     * （换人做是另一种排法 —— 那要让客人在电话里换两次房间，先不做。）
     * 加项挂在第一段上：它们不是独立的活，时长并进那一段。
     */
    const addonMin = addons.reduce((n, a) => n + a.durationMin, 0);
    const items = staffIds.flatMap((membershipId) => {
      let cursor = new Date(startsAt!).getTime();
      return mains.map((m, i) => {
        const durationMin = m.durationMin + (i === 0 ? addonMin : 0);
        const item = {
          serviceId: m.id,
          addonIds: i === 0 ? addons.map((a) => a.id) : [],
          membershipId,
          // 点钟只算客人真的报了名字的那一位；凑人数补上的不算点钟
          isRequest: Boolean(staffId) && membershipId === staffId,
          resourceId: null,
          startsAt: new Date(cursor).toISOString(),
          durationMin,
          details: {},
        };
        cursor += durationMin * 60_000;
        return item;
      });
    });

    try {
      if(depositQuote){
        const selection=staffIds.flatMap((membershipId,guestIndex)=>mains.map((m,index)=>({guestIndex,serviceId:m.id,
          addonIds:index===0?addons.map(a=>a.id):[],staffId:membershipId})));
        const result=await dispatch('voice.submitBooking',VoiceBookingInput.parse({serviceId:mains[0]!.id,
          date:businessDateOf(new Date(startsAt!),t.timezone,'00:00'),startsAt:startsAt!,partySize,items:selection,
          quotedTotalCents:depositQuote.serviceTotalCents,providerCallId:callId??undefined,customerName:callerName!,phoneE164:fromE164!,
          email:str(body['email'])??undefined,notes:str(body['health_notes'])??str(body['notes'])??undefined,
          depositConsent:consent.success?consent.data:undefined}),ctx,
          {idempotencyKey:callId?`telnyx-deposit-book-${callId}`:crypto.randomUUID(),systemOrigin:'telnyx_voice'});
        const current=await withTenant(ctx,tx=>currentVoiceBooking(tx,ctx,SubmitVoiceBooking.output.parse(result.result).appointmentId));
        void flushEmails(ctx,req.log);void flushSms(ctx,req.log);
        return {ok:true,shop:shopOf(t),...current,replayed:result.replayed,durationMin:totalMin,
          say:current.deposit?.additionalPayment?
            'Your existing appointment remains confirmed. There is a separate additional deposit request. Please use the payment instructions or contact the front desk; your card will not be charged automatically.':current.bookingConfirmed?'Your appointment is confirmed.':current.status==='pending_deposit'?
            `The time is held, awaiting your deposit. Please pay before ${new Intl.DateTimeFormat('en-US',{timeZone:t.timezone,hour:'numeric',minute:'2-digit'}).format(new Date(current.deposit!.expiresAt))}. `
              +(current.deposit!.paymentAction==='email_link'?
                (current.deposit!.emailDelivery==='sent'?'Use the emailed instructions to pay and confirm your appointment.':
                  'Payment instructions are queued. Your appointment is not confirmed yet; the front desk can help with payment.'):
                'The front desk can help you arrange payment. Your appointment is not confirmed yet.'):
            'The appointment is not confirmed. Please contact the front desk for assistance.',
          guidance:'Follow bookingConfirmed and status. A pending deposit is a temporary hold, not a confirmation. Never read internal IDs or payment URLs aloud.'};
      }
      const out = await dispatch<{
        appointmentId: string; businessDate: string; itemIds: string[];
      }>(
        'appointment.create',
        {
          customerId: null,
          items,
          partySize,
          notes: str(body['health_notes']) ?? str(body['notes']) ?? undefined,
          source: 'phone_ai',
          providerCallId:callId ?? undefined,
          // ⚠️ override 永不传 —— 软约束放行需要一个知道店里现在什么情况的人
          guest: {
            manageToken,
            customer: {
              name: callerName!,
              email:str(body['email'])??undefined,
              phoneE164: fromE164!,
              // 预约确认短信是事务性的，不需要这个开关；这里管的是营销短信（TCPA）
              smsOptIn: false,
            },
          },
        },
        ctx,
        { idempotencyKey: callId ? `telnyx-book-${callId}` : crypto.randomUUID() },
      );

      // 确认短信在事务提交之后才发。不 await —— 一条短信发不出去
      // 永远不该拖慢或推翻一次成功的建单（宪法第 14 条）
      void flushSms({ orgId: t.orgId, locationId: t.locationId, membershipId: null }, req.log);
      void flushEmails({ orgId: t.orgId, locationId: t.locationId, membershipId: null }, req.log);

      return {
        ok: true,
        shop: shopOf(t),
        appointmentId: out.result.appointmentId,
        businessDate: out.result.businessDate,
        durationMin: totalMin,
        services: matched.map((m) => ({ name: m.name, isAddon: m.isAddon })),
        // Repeat the appointment time in the store timezone.
        say: `You're all set for ${matched[0]?.name ?? 'your appointment'} on `
          + `${spokenTime(new Date(startsAt!), t.timezone).spokenAt}. `
          + "We'll text your appointment details to this number. See you then!",
      };
    } catch (e) {
      /*
       * 时段被抢走是这条路上最常见的失败（客人在电话里犹豫的那一分钟，
       * 前台或网站把它订走了）。这时**不能重试**，要回去重新报时间。
       */
      const code = e instanceof AppError ? e.code : 'UNKNOWN';
      if(e instanceof AppError&&['deposit_quote_changed','deposit_confirmation_required'].includes(String(e.details?.reason)))return {
        ok:false,error:code,deposit:e.details?.deposit,say:'The deposit quote or policy changed. Let me confirm the updated details with you.',
        guidance:'Refresh the deposit quote and obtain agreement to its exact amount and cancellation policy before trying again.'};
      const taken = code === 'RESOURCE_CONFLICT' || code === 'OUTSIDE_BUSINESS_HOURS'
        || code === 'STAFF_OVER_CAPACITY' || code === 'LOCATION_OVER_CAPACITY';
      return {
        ok: false,
        error: code,
        say: taken
          ? "I'm sorry, that time was just taken. Let me find you another one."
          : "I'm sorry, something went wrong on our end. Let me have the front desk call you "
            + 'right back.',
        guidance: taken
          ? 'Call find_slots again for a fresh time, then book_appointment.'
          : 'Call request_callback. Do not retry book_appointment.',
      };
    }
  });

  // ── webhook：通话事件 → 计费 ────────────────────────────────────────────
  app.post('/v1/telnyx/webhook', async (req) => {
    const body = verified(req);
    const data = (body['data'] ?? {}) as Record<string, unknown>;
    const payload = (data['payload'] ?? {}) as Record<string, unknown>;
    const eventType = str(data['event_type']);

    /**
     * ⭐ 入站短信 —— **必须在下面那句 tenantForNumber 之前处理**。
     *
     * 短信的 `to` 是**平台号**（TELNYX_SMS_FROM），它不属于任何一家店，
     * 反查租户一定失败。同意状态本来也是平台级的（docs/09 §5.1、sql/0034）：
     * 客人回 STOP 是对我们这个发送者说的，不是对某一家店。
     */
    if (eventType === 'call.recording.saved') {
      const recordingId = str(payload['recording_id']);
      if (!recordingId) return { ok: true, ignored: 'missing_recording_id' };
      const metadata = await getRecordingMetadata(recordingId);
      const to = str(payload['to']) ?? metadata.to;
      const t = await tenantForNumber(to);
      if (!t.assistantId?.startsWith('agent_')) return { ok: true, ignored: 'not_xai_line' };
      const callId = str(payload['call_session_id']) ?? metadata.call_session_id;
      if (!callId) return { ok: true, ignored: 'missing_call_id' };
      const boundary = await recordingBoundary(metadata);
      if (boundary === null) return { ok: true, pending: 'waiting_for_sip_records' };
      await dispatch('call.queueRecording', { providerCallId: callId, recordingId, to,
        from: str(payload['from']) ?? metadata.from,
        startedAt: metadata.recording_started_at,
        durationSeconds: Math.max(0, Math.round(Number(metadata.duration_millis ?? 0) / 1000)),
        ...boundary,
      }, systemContext(t), { systemOrigin: 'telnyx_recording', idempotencyKey: `recording-${recordingId}` });
      return { ok: true, queued: true };
    }

    if (eventType === 'message.finalized' || eventType === 'message.sent') {
      await recordSmsDelivery(payload, data['occurred_at']);
      return { ok: true };
    }

    if (eventType === 'message.received') {
      return handleInboundSms(payload, req.log);
    }

    // 只认挂机事件。别的事件（answered / speak.ended…）照常 200，
    // 不然 Telnyx 会认为投递失败并一直重试。
    //
    // ⚠️ 但要**记一行日志**：2026-08-23 第一通真实电话之后 `phone_calls`
    // 是空的，而 webhook 明明收到了两条 —— 分不清是「Telnyx 把 call.hangup
    // 发去了别处」还是「我们把它当成别的事件忽略了」。不记的话下一通电话
    // 还是查不出来。
    if (eventType !== 'call.hangup') {
      req.log.info({ eventType, callId: str(payload['call_session_id']) },
        'telnyx webhook ignored');
      return { ok: true, ignored: eventType };
    }

    const t = await tenantForNumber(str(payload['to']));
    const ctx = systemContext(t);

    const startedAt = str(payload['start_time']);
    const endedAt = str(payload['end_time']) ?? new Date().toISOString();
    const durationSeconds = startedAt
      ? Math.max(0, Math.round((new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 1000))
      : 0;

    const callId = str(payload['call_session_id']) ?? str(payload['call_control_id']) ?? '';
    if (!callId) return { ok: true, ignored: 'missing_call_id' };

    const out = await dispatch<{ callId: string; billedMinutes: number }>(
      'call.record',
      {
        providerCallId: callId,
        fromE164: str(payload['from']),
        toE164: str(payload['to']),
        startedAt, endedAt, durationSeconds,
        deferBilling: t.assistantId?.startsWith('agent_') ?? false,
        outcome: str(payload['hangup_cause']) === 'normal_clearing' ? 'completed' : 'failed',
      },
      ctx,
      { idempotencyKey: `telnyx-hangup-${callId}` , systemOrigin: 'telnyx_call' });

    // ⭐ 电话也会烧余额，挂机记完账顺手看一眼要不要自动续充（事务外）。
    // ⚠️ 换一个上下文：电话那个 actor 的四条权限里**没有** billing.manage ——
    // 一个靠签名进来的入口不该有扣客户钱的权限（见 billing/autoTopup.ts）
    // 电话烧的是**语音分钟**那本账，不是积分
    void maybeAutoTopup(billingSystemContext(ctx), 'voice_minute', req.log);

    return { ok: true, billedMinutes: out.result.billedMinutes };
  });

  // ── 模糊匹配：听到的名字 → 库里的 id ───────────────────────────────────
  //
  // 匹配不上就返回 null，**原话照样存**（call_drafts 两个字段都留）。
  // 猜一个「最像的」项目比留空危险得多：前台屏幕上会写着一个看起来
  // 完全正常的项目名，而客人说的是另一个。

  /** 项目表。找空档要时长，报价要价格，建单要区分主项目和加项 */
  async function loadCatalog(t: Tenant): Promise<CatalogItem[]> {
    const rows = await withTenant(
      { orgId: t.orgId, locationId: t.locationId, membershipId: null },
      (tx) => tx<{
        id: string; name: unknown; duration_min: number;
        price_cents: number; is_addon: boolean;
      }[]>`
        select id, name, duration_min, base_price_cents as price_cents, is_addon
        from services
        where location_id = ${t.locationId} and active = true`);
    return rows.map((r) => ({
      id: r.id,
      name: pickText(r.name, 'en'),
      durationMin: r.duration_min,
      priceCents: r.price_cents,
      isAddon: r.is_addon,
    }));
  }

  async function matchService(t: Tenant, heard: string | undefined): Promise<string | null> {
    if (!heard) return null;
    const catalog = await loadCatalog(t);
    return bestMatch(heard, catalog.map((c) => ({ id: c.id, text: c.name })));
  }

  /**
   * 一串听到的项目名 → 库里的项目。
   *
   * 匹配不上的**原样留在 `unmatched` 里**给 AI 去跟客人核对 ——
   * 悄悄丢掉的话，客人说的「再加个热石」会凭空消失，
   * 而他到店时以为已经加上了。
   */
  async function resolveHeardServices(
    t: Tenant, heard: readonly string[],
  ): Promise<{ matched: CatalogItem[]; unmatched: string[] }> {
    const catalog = await loadCatalog(t);
    const pool = catalog.map((c) => ({ id: c.id, text: c.name }));
    const byId = new Map(catalog.map((c) => [c.id, c]));

    const matched: CatalogItem[] = [];
    const unmatched: string[] = [];
    for (const h of heard) {
      const id = bestMatch(h, pool);
      if (id) matched.push(byId.get(id)!);
      else unmatched.push(h);
    }
    return { matched, unmatched };
  }

  /**
   * 一起来的几位客人，各配一位技师。
   *
   * ⚠️ 人选**不由模型决定**：它拿到的 slot 里有哪些人有空是三十秒前的事，
   * 而这三十秒里前台可能已经把其中一位派出去了。这里在建单前
   * 用同一个排期引擎重新算一遍那个时刻，凑不齐就不建单。
   *
   * 客人点名的那位排在最前 —— 她要是还在，就该是她。
   */
  async function pickPartyStaff(t: Tenant, args: {
    startsAt: string; durationMin: number; partySize: number;
    preferred: string | null; genderPreference: string | null;
  }): Promise<Array<string | null>> {
    const around = new Date(args.startsAt);
    if (Number.isNaN(around.getTime())) return [];

    const slots = await withTenant(
      { orgId: t.orgId, locationId: t.locationId, membershipId: null },
      // preferred 不传给引擎：传了就只剩她一个人，凑不齐第二位
      (tx) => loadSlotContext(tx, t.locationId, around, args.durationMin, null, {
        limit: 400,
        partySize: args.partySize,
        genderPreference: args.genderPreference,
      }));

    const wanted = around.getTime();
    const free = slots.slots.filter((s) => s.startsAt.getTime() === wanted);
    const ids = [...new Set(free.map((s) => s.membershipId))];
    if (args.preferred && ids.includes(args.preferred)) {
      ids.splice(ids.indexOf(args.preferred), 1);
      ids.unshift(args.preferred);
    }
    return ids.slice(0, args.partySize);
  }

  async function matchStaff(t: Tenant, heard: string | undefined): Promise<string | null> {
    if (!heard) return null;
    const rows = await withTenant(
      { orgId: t.orgId, locationId: t.locationId, membershipId: null },
      (tx) => tx<{ membership_id: string; name: unknown }[]>`
        select sp.membership_id, sp.display_name as name
        from staff_profiles sp
        join memberships m on m.id = sp.membership_id and m.status = 'active'
        where sp.location_id = ${t.locationId} and sp.is_bookable = true`);
    return bestMatch(heard, rows.map((r) => ({ id: r.membership_id, text: pickText(r.name, 'en') })));
  }
}

/** 报给客人听的一行价目 */
interface PriceRow {
  serviceId: string;
  name: string;
  description: string | null;
  durationMin: number;
  priceCents: number;
  category: string | null;
  isAddon: boolean;
}

/** 库里的一个项目（或加项）。听到的名字最终要落到这上面 */
interface CatalogItem {
  id: string;
  name: string;
  durationMin: number;
  priceCents: number;
  /** true = 加项，只能加在主项目上，不能单独预约 */
  isAddon: boolean;
}

/** 那天没空档时给的改期建议。**不能**混进 `slots` 里 */
interface Alternative {
  businessDate: string;
  dateLabel: string;
  slots: Array<{ startsAt: string; label: string; spokenAt: string; staff: string }>;
}

/**
 * find_slots 的 `guidance` —— AI 该怎么办写在返回里，不藏在 prompt 里。
 *
 * 每一句都对应一种「不这么说会怎样」：
 *   没空档又不说明是改期建议 → 客人照着周六来，而那是下周三
 *   项目没匹配上却不提 → 时长是估的，位置放不下，坑的是后面那位客人
 *   两位客人却按一位报时间 → 到店发现第二位没人接
 */
function slotsGuidance(args: {
  hasSlots: boolean;
  alternatives: readonly Alternative[];
  partySize: number;
  genderPreference: string | null;
  unmatched: readonly string[];
}): string {
  const parts: string[] = [];

  if (args.hasSlots) {
    parts.push(
      'Offer only the times below. Never work out a time of your own. '
      // ⭐ 这一句是 2026-08-24 那通电话换来的：模型把 UTC 的 17:00 念成了 5 PM，
      // 而那家店在洛杉矶（上午十点）。客人听到的和订下去的差七小时
      + 'Say the `spokenAt` (or `label`) of a slot — they are already in the salon\'s local '
      + 'time. NEVER read `startsAt`: it is UTC and will be hours off. '
      + 'Pass `startsAt` back to book_appointment unchanged. ');
    if (args.partySize > 1) {
      parts.push(`Each time below already has ${args.partySize} therapists free at once. `);
    }
  } else if (args.alternatives.length > 0) {
    parts.push(
      'The day they asked for is full. The times in `alternatives` are on OTHER DAYS — '
      + 'say that day is full first, then offer the other day BY NAME using its `dateLabel` '
      + '("we are full Saturday — would Wednesday, August 26 work?"). '
      + 'Never read an alternative as if it were the day they wanted. '
      + 'Say `spokenAt` / `label`, never `startsAt`. ');
  } else {
    parts.push(
      'Nothing is open that day. Ask them to try another day, or offer to have the front desk '
      + 'call them back. Do not offer a time of your own. ');
    if (args.genderPreference) {
      parts.push(
        '(No therapist of the gender they asked for is working that day — say so; '
        + 'do not quietly offer someone else instead.) ');
    }
  }

  if (args.unmatched.length > 0) {
    parts.push(
      `"${args.unmatched.join('", "')}" is not on the service list, so the duration is a guess. `
      + 'Check the service name with the caller before you offer any time.');
  }
  return parts.join('');
}

/**
 * 保守的名字匹配：只认**完全相等**或**一方包含另一方**。
 *
 * 刻意不做编辑距离 —— "gel manicure" 和 "gel removal" 的距离很近，
 * 而它们是两个完全不同的活儿，价格差一倍。宁可匹配不上让前台填，
 * 也不要匹配错让前台以为已经填对了。
 */
function bestMatch(heard: string, pool: Array<{ id: string; text: string }>): string | null {
  const h = norm(heard);
  if (!h) return null;

  const exact = pool.filter((p) => norm(p.text) === h);
  if (exact.length === 1) return exact[0]!.id;

  const contains = pool.filter((p) => {
    const t = norm(p.text);
    return t.includes(h) || h.includes(t);
  });
  // 命中多个 = 有歧义（"gel" 同时像 "Gel Manicure" 和 "Gel Pedicure"），
  // 这时候留空比挑一个强
  return contains.length === 1 ? contains[0]!.id : null;
}

const norm = (v: string) => v.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined;
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

/**
 * `services` 这个入参。模型有时给数组，有时给一句
 * 「Deep Tissue 60min, hot stone」——两种都收，空数组当没给（返回 null）。
 */
const strArray = (v: unknown): string[] | null => {
  if (Array.isArray(v)) {
    const out = v.map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean);
    return out.length > 0 ? out : null;
  }
  if (typeof v === 'string' && v.trim()) {
    const out = v.split(/[,、+]|\band\b/i).map((x) => x.trim()).filter(Boolean);
    return out.length > 0 ? out : null;
  }
  return null;
};

const listOf = (v: string | undefined): string[] => (v ? [v] : []);

const clampInt = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, Math.floor(v)));

/**
 * 性别偏好。只认 male / female —— 别的一律当没提。
 *
 * 模型会传 "woman"、"f"、"female therapist" 这类东西，
 * 直接拿去比 `staff_profiles.gender` 会一个人都匹配不上，
 * 而那时候的表现是「这一天没有空档」，看起来像排班问题。
 */
function normGender(v: string | undefined): string | null {
  if (!v) return null;
  const s = v.toLowerCase();
  if (/\bf\b|female|woman|women|girl|lady|女/.test(s)) return 'female';
  if (/\bm\b|male|man|men|guy|男/.test(s)) return 'male';
  return null;
}

/**
 * ⭐ 一个时刻 → 门店墙上时间的**人话**。
 *
 * 2026-08-24 第二通真实电话上暴露的问题：`find_slots` 返回的是
 * `2026-08-26T17:00:00.000Z`（UTC ISO），旁边虽然给了 `timezone`，
 * 但模型直接把 17:00 念成了 "5 PM" —— 而那家店在洛杉矶，实际是上午十点。
 * **客人听到的时间和订下去的差七小时**，而短信里是对的，
 * 所以这个错要到客人下午五点来敲门才会被发现。
 *
 * 结论不是「在 prompt 里叮嘱模型换算时区」——
 * 是**后端根本不该把生的 UTC 丢给它**。这里直接给出可以照念的句子。
 */
function spokenTime(at: Date, timezone: string): { label: string; spokenAt: string } {
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(at);
  const day = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, weekday: 'long', month: 'long', day: 'numeric',
  }).format(at);
  return { label: time, spokenAt: `${day} at ${time}` };
}

/** 营业日（YYYY-MM-DD）→ "Wednesday, August 26"。改期建议要报得出日子 */
function spokenDate(businessDate: string, timezone: string): string {
  // 正午作锚点：cutoff 最晚也就凌晨几点，正午永远落在同一个营业日
  const at = wallMinuteToInstant(businessDate, timezone, 12 * 60);
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, weekday: 'long', month: 'long', day: 'numeric',
  }).format(at);
}

/** 门店墙上时间的分钟数，用来把「客人说的时间」排到前面 */
function minutesOf(d: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  return Number(parts.find((p) => p.type === 'hour')?.value ?? 0) * 60
    + Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
}

/**
 * 入站短信：认关键词、落库、该回的回。
 *
 * ## 四种意图,三种处理
 *
 * | 客人发的 | 我们做什么 |
 * | :--- | :--- |
 * | STOP / UNSUBSCRIBE / **CANCEL** / QUIT | 记 `opted_out`,**不回**（见下） |
 * | START / YES | 记 `opted_in` |
 * | HELP / INFO | **只留档** —— 回复由 Telnyx 那边自动发（见下） |
 * | 别的 | 只留档。我们不做短信对话 |
 *
 * ## ⚠️ 退订之后为什么不回一条「已退订」
 *
 * 运营商在**网络层**就把这个号到他的短信掐了,我们再发只会被拒（还计一次费）。
 * 而且 10DLC 的退订确认由运营商/Telnyx 自动发 —— 我们再发一条是**重复**。
 *
 * ## 🔴 CANCEL 的歧义:这里是它唯一能被记下来的地方
 *
 * 客人打 CANCEL 多半是想取消**预约**,而运营商规定这个词必须退订。
 * 退订之后我们**再也发不了短信给他** —— 所以这条原话进 `sms_inbound`
 * 是前台唯一的线索。docs/09 §5.3 里写了这件事该怎么跟店家交代。
 */
async function handleInboundSms(
  payload: Record<string, unknown>,
  log: { info: (o: unknown, m: string) => void },
): Promise<{ ok: true; intent: string }> {
  const rawFrom = str(((payload['from'] ?? {}) as Record<string, unknown>)['phone_number'])
    ?? str(payload['from']) ?? '';
  const toArr = (payload['to'] ?? []) as Array<Record<string, unknown>>;
  const rawTo = str(toArr[0]?.['phone_number']) ?? str(payload['to']) ?? '';
  // 验签已过（上游 verified()）。归属与同意状态都按字符串精确匹配号码，
  // 先规范 E.164，上游偶发的非规范写法（缺 `+`、带分隔符）才不会误判（计划 §3.3）。
  const from = normalizePhoneE164(rawFrom) ?? rawFrom;
  const to = normalizePhoneE164(rawTo) ?? rawTo;
  const text = str(payload['text']) ?? '';
  const providerId = str(payload['id']) ?? null;

  const intent = classify(text);
  await recordInboundSms({ fromE164: from, toE164: to, body: text, intent, providerId });

  if (intent === 'opt_out') {
    await setSmsConsent(from, 'opted_out', text.trim().toUpperCase().slice(0, 32));
    log.info({ from }, 'sms opt-out recorded');
    return { ok: true, intent };
  }

  if (intent === 'opt_in') {
    await setSmsConsent(from, 'opted_in', text.trim().toUpperCase().slice(0, 32));
    return { ok: true, intent };
  }

  /**
   * ⚠️ **HELP 不由我们回。**
   *
   * 三组关键词的自动回复配在 Telnyx 的 messaging profile 上
   * （`autoresp_configs`，docs/09 §5.4）—— 我们再回一条就是**重复**：
   * 客人问一句 HELP 收到两条一模一样的说明。
   *
   * 分工是清楚的：
   *   Telnyx  回复 + 运营商层面的拦截（合规那一半，我们的服务挂了它照常работа）
   *   我们    留档 + `sms_consent`（前台要看得到，发之前要拦得住）
   */
  return { ok: true, intent };
}
