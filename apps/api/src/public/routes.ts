import { serviceGuestCount } from '@gf/contracts';
import {defaultBookingMedia,bookingMediaUrl} from '@gf/contracts';
/**
 * 公开预约 API —— 门店官网上的「在线预约」（docs/13）。
 *
 * ## 这条路和系统里其它所有路都不一样
 *
 * Telnyx 的 webhook 前面站的是机器，Kiosk 前面站的是客人（但那台 iPad 是
 * 老板亲手配对的）。**这里前面站的是互联网。** 所以每一条都要按
 * 「一个陌生人能拿它干什么」来读。
 *
 * ## 收窄发生在这个文件里
 *
 * 上下文里确实有 `appointment.write`（不然建不出预约），但官网**说了不算**：
 * 每一次 dispatch 的入参都是这里拼的 —— `source` 恒为 `'web'`、
 * `override` 永不传、项目必须是本店 `online_bookable` 的、
 * 价格和时长一律取库里的。理由见 `publicAuth.ts` 文件头。
 *
 * ## 顺序是有意的：便宜的检查在前
 *
 *   认门店(1 次查询) → 域名白名单(内存) → 入参 Zod → 蜜罐/填表耗时(内存)
 *     → 限频(1 次 HTTP) → Turnstile(1 次 HTTP) → 业务校验 → 建单
 *
 * 把 Turnstile 放前面的话，每一个傻脚本都要花掉我们一次 Cloudflare 往返。
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError, ERROR_CODES, pickText, phoneE164, readPublicBookingProfile } from '@gf/contracts';
import { withTenant, ts, parseTs, type PublicShopRow } from '@gf/db';
import { businessDateOf, isBookableDate } from '@gf/scheduling';
import { dispatch } from '../bus';
import { quoteBundle } from '../queries/bundle';
import { flushEmails } from '../email/flush';
import { flushSms } from '../sms/flush';
import {
  resolveShop, resolveHostedShop, resolveManagedBooking,
  assertOriginAllowed, publicContext, PUBLIC_KEY_HEADER,
} from './publicAuth';
import {
  guestCancelBlockReason, guestRescheduleBlockReason, loadManagedBookingDetail,
} from './managedDetail';
import { checkManagedRescheduleSlot, loadManagedAvailability } from './managedAvailability';
import { assertHuman } from './turnstile';
import { checkRateLimits } from './rateLimit';
import {
  generateManageToken, hashManageToken, sameDigest, replayableManageToken,
} from './bookingToken';
import '../handlers/appointment';
import { loadPartyAvailability } from './partyAvailability';

/**
 * 真人填这张表最快也要几秒：选日子、选时段、填名字、填手机号。
 * 三秒内交卷的只有脚本。
 *
 * ⚠️ 这个数字来自客户端自报的 `formElapsedMs`，**伪造起来毫不费力** ——
 * 它挡的是照着表单字段无脑 POST 的那一类，不是任何认真的人。
 * 便宜、对真人零摩擦，所以值得有；但它一条都不能算作安全边界。
 */
const MIN_FILL_MS = 3000;

/** 同一个手机号未来能挂几条没完成的预约（docs/13 §6.6，防恶意占位） */
const MAX_UPCOMING_PER_PHONE = 3;

const localeOf = (q: unknown, shop: PublicShopRow): string =>
  typeof q === 'string' && q ? q : shop.defaultLocale;

const originOf = (req: FastifyRequest): string | undefined =>
  typeof req.headers.origin === 'string' ? req.headers.origin : undefined;

function publicShopPayload(shop: PublicShopRow, locale: string) {
  const {services: _services, shopNotifications: _notifications, ...publicProfile} = readPublicBookingProfile(shop.settings);
  return {
    publicProfile:{...publicProfile,coverUrl:publicProfile.coverUrl || bookingMediaUrl('spa')},
    name: pickText(shop.name, locale),
    slug: shop.slug,
    timezone: shop.timezone,
    currency: shop.currency,
    businessDayCutoff: shop.businessDayCutoff,
    phone: shop.phone,
    address: shop.address,
    businessHours: shop.businessHours,
    locales: [shop.defaultLocale],
    onlineBooking: {
      enabled: shop.onlineBooking.enabled,
      maxDaysAhead: shop.onlineBooking.maxDaysAhead,
      minMinutesAhead: shop.onlineBooking.minMinutesAhead,
      requirePhoneVerification: shop.onlineBooking.requirePhoneVerification,
      cancelCutoffHours: shop.onlineBooking.cancelCutoffHours,
      rescheduleEnabled: shop.onlineBooking.rescheduleEnabled,
      rescheduleCutoffHours: shop.onlineBooking.rescheduleCutoffHours,
      selfRescheduleMax: shop.onlineBooking.selfRescheduleMax,
      allowClientPickStaff: shop.onlineBooking.allowClientPickStaff,
      cancellationPolicyNotice: shop.onlineBooking.cancellationPolicyNotice,
    },
    turnstileSiteKey: process.env['TURNSTILE_SITE_KEY'] ?? null,
  };
}

// ── 入参 ─────────────────────────────────────────────────────────────────────

const bookingBody = z.object({
  turnstileToken: z.string().min(1).max(4096),
  locale: z.string().max(16).optional(),
  customer: z.object({
    name: z.string().min(1).max(120),
    phone: phoneE164,
    email: z.string().email().max(200).optional(),
    smsOptIn: z.boolean().default(false),
    bookingSmsConsent: z.boolean().default(false),
  }),
  items: z.array(z.object({
    guestIndex: z.number().int().min(0).max(9).optional(),
    guestIndices: z.array(z.number().int().min(0).max(9)).min(1).max(10).optional(),
    quotedPriceCents: z.number().int().nonnegative().optional(),
    serviceId: z.string().uuid(),
    addonIds: z.array(z.string().uuid()).max(6).default([]),
    staffId: z.string().uuid().nullable().default(null),
    startsAt: z.string().datetime({ offset: true }),
  })).max(20).default([]),
  /**
   * 组合套餐选择（U10 / 计划 §7）。官网只提供 bundleId + 起始时刻 +（可选）
   * 额外加项；技师指派、额外优惠、模板版本一律不接受客户端传入 —— 展开、
   * 排程与定价全部由服务端 `appointment.create` 调 `quoteBundle` 完成。
   */
  bundleSelections: z.array(z.object({
    bundleId: z.string().uuid(),
    expectedVersion: z.number().int().positive().optional(),
    startsAt: z.string().datetime({ offset: true }),
    extraAddons: z.array(z.object({
      ref: z.string().min(1).max(64),
      attachToUnit: z.string().min(1).max(80),
      serviceId: z.string().uuid(),
      qty: z.number().int().min(1).max(10).default(1),
    })).max(20).default([]),
  })).max(4).default([]),
  partySize: z.number().int().min(1).max(20).default(1),
  notes: z.string().max(500).optional(),
  /** 蜜罐。真人看不见这个字段，所以它永远是空的 */
  website: z.string().max(200).optional(),
  /** 从打开表单到提交过了多久。见 MIN_FILL_MS 上面那段的保留意见 */
  formElapsedMs: z.number().int().min(0).max(86_400_000).optional(),
}).refine((b) => b.items.length > 0 || b.bundleSelections.length > 0, {
  message: 'items 与 bundleSelections 至少有一个非空',
});

/** 组合套餐报价请求（只读路由 /public/v1/bundle-quote）。 */
const bundleQuoteBody = z.object({
  locale: z.string().max(16).optional(),
  bundleId: z.string().uuid(),
  extraAddons: z.array(z.object({
    ref: z.string().min(1).max(64),
    attachToUnit: z.string().min(1).max(80),
    serviceId: z.string().uuid(),
    qty: z.number().int().min(1).max(10).default(1),
  })).max(20).default([]),
});

const cancelBody = z.object({
  manageToken: z.string().min(8).max(200),
  /**
   * ⭐ 手机后四位（批 2，docs/13 §4.6）。
   *
   * 令牌一个人拿到就能操作，而确认邮件是会被转发、会被同事看到的。
   * 加这一道之后，捡到链接的人还得知道客人的手机尾号才动得了 ——
   * 而客人自己早就习惯输后四位（门口 iPad 签到就是这个动作）。
   *
   * 可选：**建单时没留手机号的单没法验**，那种单只能靠令牌本身
   * （同时它的 manage URL 也不会进邮件，见 handlers/appointment.ts）
   */
  last4: z.string().regex(/^\d{4}$/).optional(),
  turnstileToken: z.string().min(1).max(4096).optional(),
});

const rescheduleBody = z.object({
  manageToken: z.string().min(8).max(200),
  last4: z.string().regex(/^\d{4}$/).optional(),
  requestId: z.string().uuid().optional(),
  startsAt: z.string().datetime({ offset: true }),
  turnstileToken: z.string().min(1).max(4096).optional(),
});

const hostedManageBody = z.object({
  slug: z.string().min(1).max(80),
  manageToken: z.string().min(8).max(200),
  locale: z.string().max(16).optional(),
});

const hostedAvailabilityBody = z.object({
  slug: z.string().min(1).max(80),
  manageToken: z.string().min(8).max(200),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export function registerPublicRoutes(app: FastifyInstance): void {
  // ── 1. 门店信息 ───────────────────────────────────────────────────────────
  //
  // 官网第一个调它：turnstileSiteKey 和 timezone 都从这里来。
  // ⚠️ 在线预约**关着的时候这条也要能通** —— 官网要靠它决定
  // 「显示预约表单」还是「只显示电话」。
  app.get<{ Querystring: { locale?: string } }>('/public/v1/shop', async (req) => {
    const shop = await resolveShop(req.headers);
    assertOriginAllowed(originOf(req), shop);
    return publicShopPayload(shop, localeOf(req.query.locale, shop));
  });

  // Hosted booking bootstrap: book.geniefront.com/{slug} has no public-key
  // header. The key is returned because it is already public; the client
  // keeps it in memory and does not put it back in the canonical URL.
  app.get<{
    Params: { slug: string };
    Querystring: { locale?: string };
  }>('/public/v1/hosted/shops/:slug', async (req) => {
    const shop = await resolveHostedShop(req.params.slug);
    assertOriginAllowed(originOf(req), shop);
    const locale=localeOf(req.query.locale,shop);
    const team=await withTenant({orgId:shop.orgId,locationId:shop.locationId,membershipId:null},async tx=>{
      const rows=await tx<{id:string;name:unknown;avatar_url:string|null;bio:unknown}[]>`select sp.membership_id as id,sp.display_name as name,sp.photo_url as avatar_url,sp.bio from staff_profiles sp join memberships m on m.id=sp.membership_id where sp.location_id=${shop.locationId} and sp.is_bookable and m.status='active' order by sp.display_name->>'en',sp.membership_id`;
      return rows.map(p=>({id:p.id,displayName:pickText(p.name,locale),avatarUrl:p.avatar_url,bio:p.bio?pickText(p.bio,locale):null}));
    });
    return {...publicShopPayload(shop,locale),publicKey:shop.publicKey,team};
  });

  // Token bootstrap for /l/{slug}#g/{token}. Token is in the JSON body so
  // access logs never contain it.
  // Referrer-Policy on this JSON response is not sufficient: the HTML
  // management document (Task 7) and Caddy/deploy headers (Task 10) must
  // also send Referrer-Policy: no-referrer and refuse framing.
  app.post<{ Body: unknown }>('/public/v1/hosted/manage', async (req, reply) => {
    reply.header('Referrer-Policy', 'no-referrer');
    const parsed = hostedManageBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'booking' } });
    }
    const { shop, ref } = await resolveManagedBooking(
      parsed.data.slug, parsed.data.manageToken);
    assertOriginAllowed(originOf(req), shop);
    const locale = localeOf(parsed.data.locale, shop);

    return withTenant(
      { orgId: shop.orgId, locationId: shop.locationId, membershipId: null },
      async (tx) => {
        const booking = await loadManagedBookingDetail(tx, shop, ref.appointmentId, locale);
        if (!booking) {
          throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'booking' } });
        }
        return {
          publicKey: shop.publicKey,
          shop: {...publicShopPayload(shop, locale),publicKey:shop.publicKey},
          booking,
        };
      });
  });

  // Token-scoped availability for guest reschedule. Evaluates the real
  // appointment (every item, original specialists, relative offsets).
  app.post<{ Body: unknown }>('/public/v1/hosted/availability', async (req, reply) => {
    reply.header('Referrer-Policy', 'no-referrer');
    const parsed = hostedAvailabilityBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'booking' } });
    }
    const { shop, ref } = await resolveManagedBooking(
      parsed.data.slug, parsed.data.manageToken);
    assertOriginAllowed(originOf(req), shop);

    const today = businessDateOf(new Date(), shop.timezone, shop.businessDayCutoff);
    if (!isBookableDate(parsed.data.date, today, shop.onlineBooking.maxDaysAhead)) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
        details: { reason: 'date_out_of_window', maxDaysAhead: shop.onlineBooking.maxDaysAhead },
      });
    }

    return withTenant(
      { orgId: shop.orgId, locationId: shop.locationId, membershipId: null },
      (tx) => loadManagedAvailability(tx, shop, ref.appointmentId, parsed.data.date));
  });

  // ── 2. 可在线预约的项目 ───────────────────────────────────────────────────
  //
  // ⚠️ 只返回老板逐项勾过 `online_bookable` 的。没勾的（要面谈报价的美睫、
  // 只给熟客做的项目）**不在这里出现**，也不许被绕过 —— 见 §4 的校验。
  app.get<{ Querystring: { locale?: string } }>('/public/v1/services', async (req) => {
    const shop = await resolveShop(req.headers);
    assertOriginAllowed(originOf(req), shop);
    const locale = localeOf(req.query.locale, shop);
    const profile=readPublicBookingProfile(shop.settings);
    const visibleIds=Object.entries(profile.services).filter(([,v])=>v.visible===true).map(([id])=>id);

    return withTenant(
      { orgId: shop.orgId, locationId: shop.locationId, membershipId: null },
      async (tx) => {
        const cats = await tx<{ id: string; name: unknown; sort: number }[]>`
          select id, name, sort from service_categories
          where location_id = ${shop.locationId} order by sort, id`;

        const rows = await tx<{
          id: string; category_id: string | null; name: unknown; description: unknown;
          duration_min: number; base_price_cents: number; is_addon: boolean; online_bookable: boolean; staff_count: number;
        }[]>`
          select id, category_id, name, description, duration_min, base_price_cents, is_addon, online_bookable, staff_count
          from services
          where location_id = ${shop.locationId}
            and active = true and (online_bookable = true or id = any(${visibleIds}))
          order by sort, id`;

        const shaped = rows.filter(r=>profile.services[r.id]?.visible!==false).sort((a,b)=>(profile.services[a.id]?.sort??0)-(profile.services[b.id]?.sort??0)).map((r) => ({
          id: r.id,
          onlineBookable: r.online_bookable,
          staffCount: r.staff_count,
          guestCount: serviceGuestCount(r.name, r.staff_count, profile.services[r.id]?.guestCount),
          imageUrl: profile.services[r.id]?.imageUrl || defaultBookingMedia(pickText(r.name,'en')+' '+pickText(cats.find(c=>c.id===r.category_id)?.name,'en','')),
          categoryId: r.category_id,
          name: pickText(r.name, locale),
          description: profile.services[r.id]?.description || (r.description ? pickText(r.description, locale, '') : null),
          durationMin: r.duration_min,
          priceCents: r.base_price_cents,
          isAddon: r.is_addon,
        }));

        /*
         * ⭐ 加项单独一个数组（`is_addon`，sql/0035）。
         *
         * v1 时库里没有这个标记位，`/services` 返回的是一个平列表，
         * 官网**没法知道哪些是加项** —— 于是「热石 +$15」在预约页上
         * 长得和一个完整项目一模一样，客人可以单独把它订下来，
         * 到店才被告诉「这是加在按摩上的」。
         *
         * 现在主项目与加项分开：`services` 是能单独订的，
         * `addons` 只能挂在 `items[].addonIds` 上（§4.2）。
         * 服务端也不再接受把加项当主项目提交 —— 见 `priceAndDuration`。
         */
        return {
          categories: cats.filter(c=>shaped.some(s=>!s.isAddon&&s.categoryId===c.id)).map((c) => ({ id: c.id, name: pickText(c.name, locale) })),
          services: shaped.filter((x) => !x.isAddon),
          addons: shaped.filter((x) => x.isAddon),
        };
      });
  });

  // ── 2b. 可在线预约的组合套餐（U10 / 计划 §7）──────────────────────────────
  //
  // 只返回 online_bookable 且 active 的套餐及其组成快照（含目录原价、组合价、
  // 内建优惠）。价格口径与 `quoteBundle` 一致 —— 展开与最终分摊仍以下单时
  // 服务端报价为准，这里只供列表展示。
  app.get<{ Querystring: { locale?: string } }>('/public/v1/bundles', async (req) => {
    const shop = await resolveShop(req.headers, { requireOnlineBooking: true });
    assertOriginAllowed(originOf(req), shop);
    const locale = localeOf(req.query.locale, shop);

    return withTenant(
      { orgId: shop.orgId, locationId: shop.locationId, membershipId: null },
      async (tx) => {
        const bundles = await tx<{
          id: string; name: unknown; description: unknown; price_cents: number;
          version: number; sort: number;
        }[]>`
          select id, name, description, price_cents, version, sort
          from service_bundles
          where location_id = ${shop.locationId} and active = true and online_bookable = true
          order by sort, id`;
        if (bundles.length === 0) return { bundles: [] };

        const components = await tx<{
          bundle_id: string; service_id: string; qty: number; seq: number;
          included_addon_ids: string[]; svc_name: unknown; base_price_cents: number;
          duration_min: number; svc_active: boolean; staff_count: number;
        }[]>`
          select c.bundle_id, c.service_id, c.qty, c.seq, c.included_addon_ids,
                 s.name as svc_name, s.base_price_cents, (s.duration_min+s.buffer_before_min+s.buffer_after_min) as duration_min, s.active as svc_active, s.staff_count
          from service_bundle_components c
          join services s on s.id = c.service_id
          where c.bundle_id = any(${bundles.map((b) => b.id)})
          order by c.seq, c.id`;
        const addonIds = [...new Set(components.flatMap((c) => c.included_addon_ids))];
        const addonRows=addonIds.length?await tx<{id:string;base_price_cents:number;duration_min:number;active:boolean}[]>`
          select id,base_price_cents,(duration_min+buffer_before_min+buffer_after_min) as duration_min,active
          from services where location_id=${shop.locationId} and id=any(${addonIds})`:[];
        const addonById=new Map(addonRows.map(a=>[a.id,a.base_price_cents]));
        const addonMinutes=new Map(addonRows.map(a=>[a.id,a.duration_min]));
        const activeAddons=new Set(addonRows.filter(a=>a.active).map(a=>a.id));

        return {
          bundles: bundles.map((b) => {
            const comps = components.filter((c) => c.bundle_id === b.id);
            const originalTotalCents = comps.reduce((n, c) => {
              const included = c.included_addon_ids.reduce(
                (m, id) => m + (addonById.get(id) ?? 0), 0);
              return n + (c.base_price_cents + included) * c.qty;
            }, 0);
            return {
              id: b.id,
              version: b.version,
              name: pickText(b.name, locale),
              description: b.description ? pickText(b.description, locale, '') : null,
              priceCents: b.price_cents,
              originalTotalCents,
              bundleDiscountCents: Math.max(0, originalTotalCents - b.price_cents),
              components: comps.map((c) => ({
                serviceId: c.service_id,
                name: pickText(c.svc_name, locale),
                qty: c.qty,
                seq: c.seq,
                listPriceCents: c.base_price_cents
                  + c.included_addon_ids.reduce((m, id) => m + (addonById.get(id) ?? 0), 0),
                durationMin: c.duration_min+c.included_addon_ids.reduce((n,id)=>n+(addonMinutes.get(id)??0),0),
              })),
              bookable: comps.length>0 && comps.reduce((n,c)=>n+c.qty,0)<=20 && comps.every((c) => c.svc_active && c.staff_count===1 && c.included_addon_ids.every(id=>activeAddons.has(id))),
            };
          }),
        };
      });
  });

  // ── 2c. 组合套餐报价（只读）──────────────────────────────────────────────
  //
  // 服务端权威报价：官网预览「原价 / 优惠 / 套餐价 / 各子项」用它，
  // 与下单时 `appointment.create` 调的是同一个 `quoteBundle`（计划交付门槛：
  // 不同入口同一选择 → 同一组成与金额）。额外优惠不接受客户端传入。
  app.post<{ Body: unknown }>('/public/v1/bundle-quote', async (req, reply) => {
    const shop = await resolveShop(req.headers, { requireOnlineBooking: true });
    assertOriginAllowed(originOf(req), shop);

    const parsed = bundleQuoteBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
        details: { issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })) },
      });
    }
    const body = parsed.data;
    const locale = localeOf(body.locale, shop);

    return withTenant(
      { orgId: shop.orgId, locationId: shop.locationId, membershipId: null },
      async (tx) => {
        const [bundle] = await tx<{ id: string }[]>`
          select id from service_bundles
          where id = ${body.bundleId} and location_id = ${shop.locationId}
            and active = true and online_bookable = true`;
        if (!bundle) {
          throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
            details: { reason: 'bundle_not_online_bookable', bundleId: body.bundleId },
          });
        }
        const quote = await quoteBundle(tx, { locationId: shop.locationId }, {
          bundleId: body.bundleId,
          extraAddons: body.extraAddons,
          extraDiscountCents: 0,
          extraDiscountKind: 'manual',
        });
        return { ...quote, name: pickText(quote.nameSnapshot, locale) };
      });
  });

  // ── 3. 空档 ───────────────────────────────────────────────────────────────
  //
  // Public availability and creation share the complete item planner and capacity engine.
  app.get<{ Querystring: {
    date?: string; serviceId?: string; addonIds?: string; staffId?: string;
    bundleId?: string; excludeBookingId?: string;
  } }>('/public/v1/availability', async (req) => {
    const shop = await resolveShop(req.headers, { requireOnlineBooking: true });
    assertOriginAllowed(originOf(req), shop);

    const date = (req.query.date ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, { details: { reason: 'bad_date' } });
    }
    const bundleId = (req.query.bundleId ?? '').trim();
    const serviceId = (req.query.serviceId ?? '').trim();
    if (!serviceId && !bundleId) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, { details: { reason: 'missing_service' } });
    }
    const addonIds = (req.query.addonIds ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    // 组合套餐按整体时长排格子，且不接受指定技师（子项各自派单）。
    const staffId = bundleId ? null : ((req.query.staffId ?? '').trim() || null);
    /**
     * ⭐ 改期时把本单自己占的格子排除掉（批 2）。
     *
     * ⚠️ **这里不校验令牌，也不需要。** 它能泄露的只有「某个 uuid 在这家店
     * 有一单」—— 而空档表本来就是公开的，多一格少一格看不出是谁的。
     * 真正的写操作在 `/reschedule` 上，那条要令牌 + 后四位。
     * 在这里加令牌校验只会让「查空档」这个纯读的动作多一处能出错的地方。
     */
    const excludeBookingId = /^[0-9a-f-]{36}$/i.test(req.query.excludeBookingId ?? '')
      ? req.query.excludeBookingId! : null;

    const today = businessDateOf(new Date(), shop.timezone, shop.businessDayCutoff);
    if (!isBookableDate(date, today, shop.onlineBooking.maxDaysAhead)) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
        details: { reason: 'date_out_of_window', maxDaysAhead: shop.onlineBooking.maxDaysAhead },
      });
    }

    return withTenant(
      { orgId: shop.orgId, locationId: shop.locationId, membershipId: null },
      async (tx) => {
        if(!bundleId){
          await priceAndDuration(tx,shop,serviceId,addonIds);
          const result=await loadPartyAvailability(tx,shop,{date,excludeAppointmentId:excludeBookingId,
            items:[{guestIndex:0,serviceId,addonIds,staffId}]});
          const eligible=new Set(result.items[0]!.eligibleStaffIds);
          return {date,timezone:shop.timezone,durationMin:result.items[0]!.durationMin,
            slots:result.plans.map(p=>({startsAt:p.startsAt,staff:staffId?{id:staffId,displayName:pickText(result.staff.find(s=>s.id===staffId)?.name,'en')}:null})),
            staff:result.staff.filter(s=>eligible.has(s.id)).map(s=>({id:s.id,displayName:pickText(s.name,'en'),avatarUrl:s.avatar})),
          };
        }
        const [bundle] = await tx<{ id: string }[]>`
          select id from service_bundles where id=${bundleId} and location_id=${shop.locationId}
            and active=true and online_bookable=true`;
        if(!bundle)throw new AppError(ERROR_CODES.VALIDATION_FAILED,{details:{reason:'bundle_not_online_bookable',bundleId}});
        const quote=await quoteBundle(tx,{locationId:shop.locationId},{bundleId,extraAddons:[],extraDiscountCents:0,extraDiscountKind:'manual'});
        const result=await loadPartyAvailability(tx,shop,{date,excludeAppointmentId:excludeBookingId,
          items:quote.units.map(u=>({guestIndex:0,serviceId:u.serviceId,addonIds:u.includedAddonIds,staffId:null})),
          trustedUnits:quote.units.map(u=>({durationMin:u.durationMin,priceCents:u.netCents}))});
        return {date,timezone:shop.timezone,durationMin:result.items.reduce((n,i)=>n+i.durationMin,0),
          slots:result.plans.map(p=>({startsAt:p.startsAt,staff:null})),staff:[]};
      });
  });

  app.post<{ Body: unknown }>('/public/v1/party-availability', async (req) => {
    const shop = await resolveShop(req.headers, { requireOnlineBooking: true });
    assertOriginAllowed(originOf(req), shop);
    const limit=await checkRateLimits([{scope:'party_availability_ip',id:req.ip,limit:60,windowSec:60}],req.log);
    if(!limit.ok)throw new AppError(ERROR_CODES.VALIDATION_FAILED,{details:{reason:'too_many_attempts'}});
    const args = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      items: z.array(z.object({ guestIndex: z.number().int().min(0).max(9),
        guestIndices: z.array(z.number().int().min(0).max(9)).min(1).max(10).optional(),
        serviceId: z.string().uuid(), addonIds: z.array(z.string().uuid()).max(6).default([]),
        staffId: z.string().uuid().nullable().default(null),
      })).min(1).max(20),
    }).safeParse(req.body);
    if (!args.success) throw new AppError(ERROR_CODES.VALIDATION_FAILED);
    return withTenant({orgId:shop.orgId,locationId:shop.locationId,membershipId:null}, async tx => {
      const result = await loadPartyAvailability(tx,shop,args.data);
      return {...result,staff:result.staff.map(s=>({id:s.id,displayName:pickText(s.name,'en'),avatarUrl:s.avatar,bio:s.bio?pickText(s.bio,'en'):null}))};
    });
  });

  // ── 4. 建预约 ─────────────────────────────────────────────────────────────
  app.post<{ Body: unknown }>('/public/v1/bookings', async (req, reply) => {
    const shop = await resolveShop(req.headers, { requireOnlineBooking: true });
    assertOriginAllowed(originOf(req), shop, { forWrite: true });

    const parsed = bookingBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
        details: { issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })) },
      });
    }
    const body = parsed.data;
    if(body.partySize>1 && (body.bundleSelections.length>0 || body.items.some(i=>i.guestIndex===undefined))) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED,{details:{reason:'invalid_party'}});
    }

    const idem = (req.headers['idempotency-key'] as string | undefined)?.trim();
    if (!idem || idem.length < 8 || idem.length > 200) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
        details: { reason: 'missing_idempotency_key' },
      });
    }

    // Reject suspicious submissions without fabricating a booking: a real
    // autofill user must never receive a confirmation for a nonexistent visit.
    const looksAutomated =
      (body.website ?? '').trim().length > 0 ||
      (body.formElapsedMs !== undefined && body.formElapsedMs < MIN_FILL_MS);
    if (looksAutomated) {
      req.log.info({ locationId: shop.locationId, reason: 'honeypot' }, 'public booking dropped');
      throw new AppError(ERROR_CODES.VALIDATION_FAILED,{details:{reason:'booking_not_accepted'}});
    }

    const verdict = await checkRateLimits([
      { scope: 'ip', id: req.ip, limit: 5, windowSec: 3600 },
      { scope: 'phone', id: body.customer.phone, limit: 3, windowSec: 86_400 },
      { scope: 'shop', id: shop.locationId, limit: 30, windowSec: 3600 },
    ], req.log);
    if (!verdict.ok) {
      return reply.status(429).send({
        code: 'RATE_LIMITED',
        messageKey: 'error.RATE_LIMITED',
        details: { scope: verdict.scope, retryAfterSec: verdict.retryAfterSec },
        overridable: false,
      });
    }

    await assertHuman({ token: body.turnstileToken, ip: req.ip, idempotencyKey: idem });

    const locale = localeOf(body.locale, shop);
    const ctx = publicContext(shop, locale, req.ip);
    const recoveryToken=replayableManageToken(shop.locationId,idem,{
      customer:body.customer,items:body.items,bundleSelections:body.bundleSelections,partySize:body.partySize,notes:body.notes??'',
    });
    const replay = await withTenant(
      {orgId:shop.orgId,locationId:shop.locationId,membershipId:null},async tx=>{
        const [cached]=await tx<{id:string;manage_token_digest:string}[]>`
          select a.id,a.manage_token_digest from command_idempotency c
          join appointments a on a.id=(c.result_json->>'appointmentId')::uuid
          where c.location_id=${shop.locationId} and c.key=${idem} and c.command='appointment.create'`;
        if(!cached)return null;
        if(!recoveryToken || !sameDigest(hashManageToken(recoveryToken),cached.manage_token_digest)) {
          throw new AppError(ERROR_CODES.IDEMPOTENCY_KEY_REUSED);
        }
        return loadManagedBookingDetail(tx,shop,cached.id,locale);
      });
    if(replay) return reply.status(200).send({...replay,manageToken:recoveryToken,replayed:true,summary:replay});


    // ── 业务校验：官网传的一律不信（docs/13 §6.4）─────────────────────────
    const checked = await withTenant(
      { orgId: shop.orgId, locationId: shop.locationId, membershipId: null },
      async (tx) => {
        await assertNotSquatting(tx, shop, body.customer.phone);

        const earliest = Date.now() + shop.onlineBooking.minMinutesAhead * 60_000;
        const today = businessDateOf(new Date(), shop.timezone, shop.businessDayCutoff);
        const assertWithinWindow = (raw: string) => {
          const startsAt = new Date(raw);
          if (Number.isNaN(startsAt.getTime()) || startsAt.getTime() < earliest) {
            throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
              details: { reason: 'too_soon', minMinutesAhead: shop.onlineBooking.minMinutesAhead },
            });
          }
          const itemDate = businessDateOf(startsAt, shop.timezone, shop.businessDayCutoff);
          if (!isBookableDate(itemDate, today, shop.onlineBooking.maxDaysAhead)) {
            throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
              details: { reason: 'date_out_of_window', maxDaysAhead: shop.onlineBooking.maxDaysAhead },
            });
          }
          return startsAt;
        };

        // ── 组合套餐（U10）：只放行老板勾了 online_bookable 的模板；额外加项必须
        //    是本店 online_bookable 的 add-on。展开 / 定价交给 appointment.create。
        const bundles = [];
        for (const sel of body.bundleSelections) {
          const [bundle] = await tx<{ id: string }[]>`
            select id from service_bundles
            where id = ${sel.bundleId} and location_id = ${shop.locationId}
              and active = true and online_bookable = true`;
          if (!bundle) {
            throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
              details: { reason: 'bundle_not_online_bookable', bundleId: sel.bundleId },
            });
          }
          assertWithinWindow(sel.startsAt);
          if (sel.extraAddons.length > 0) {
            const addonIds = [...new Set(sel.extraAddons.map((a) => a.serviceId))];
            const ok = await tx<{ id: string }[]>`
              select id from services
              where location_id = ${shop.locationId} and id = any(${addonIds})
                and active = true and online_bookable = true and is_addon = true`;
            if (ok.length !== addonIds.length) {
              throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
                details: { reason: 'bundle_addon_not_online_bookable' },
              });
            }
          }
          bundles.push({
            bundleId: sel.bundleId,
            ...(sel.expectedVersion!==undefined?{expectedVersion:sel.expectedVersion}:{}),
            startsAt: new Date(sel.startsAt).toISOString(),
            extraAddons: sel.extraAddons,
          });
        }

        const items = [];
        for (const item of body.items) {
          const { durationMin, priceCents } = await priceAndDuration(
            tx, shop, item.serviceId, item.addonIds);

          const startsAt = assertWithinWindow(item.startsAt);
          if (item.staffId) await assertBookableStaff(tx, shop, item.staffId);

          items.push({
            serviceId: item.serviceId,
            addonIds: item.addonIds,
            membershipId: item.staffId,
            // 客人在官网上点名要 Amy = 点钟单。轮牌是否消耗由门店策略决定
            isRequest: item.staffId !== null,
            resourceId: null,
            startsAt: startsAt.toISOString(),
            details: { publicGuestIndex: item.guestIndex ?? 0, ...(item.guestIndices ? { publicGuestIndices: item.guestIndices } : {}), quotedPriceCents: item.quotedPriceCents },
            durationMin,
            // Trusted server total (base + add-ons). Never a client-supplied price.
            priceCentsOverride: priceCents,
          });
        }
        return { items, bundles };
      });

    // ── 建单 ──────────────────────────────────────────────────────────────
    const manageToken = recoveryToken ?? generateManageToken();

    const out = await dispatch<{ appointmentId: string; businessDate: string }>(
      'appointment.create',
      {
        customerId: null,
        items: checked.items,
        bundleSelections: checked.bundles,
        partySize: body.partySize,
        notes: body.notes,
        source: 'web',
        // ⚠️ override 永不传。公开入口没有软约束放行 —— 放行的判断
        // 需要一个知道店里现在什么情况的人，而这头没有这个人
        guest: {
          bookingSmsConsent: body.customer.bookingSmsConsent,
          manageToken,
          customer: {
            name: body.customer.name,
            phoneE164: body.customer.phone,
            ...(body.customer.email ? { email: body.customer.email } : {}),
            smsOptIn: body.customer.smsOptIn,
          },
        },
      },
      ctx,
      { idempotencyKey: idem },
    );

    // 确认信 / 确认短信都在事务提交之后才发（同 server.ts 的那条命令路）。
    // 不 await：一封信发不出去永远不该拖慢一次成功的建单（宪法第 14 条）
    const notify = { orgId: shop.orgId, locationId: shop.locationId, membershipId: null };
    void flushEmails(notify, req.log);
    void flushSms(notify, req.log);

    // Success is an authoritative committed snapshot, not the first input item.
    const summary=await withTenant(
      {orgId:shop.orgId,locationId:shop.locationId,membershipId:null},async tx=>{
        if(out.replayed){
          const [stored]=await tx<{manage_token_digest:string}[]>`select manage_token_digest from appointments where id=${out.result.appointmentId}`;
          if(!recoveryToken || !stored || !sameDigest(hashManageToken(recoveryToken),stored.manage_token_digest)) {
            throw new AppError(ERROR_CODES.IDEMPOTENCY_KEY_REUSED);
          }
        }
        return loadManagedBookingDetail(tx,shop,out.result.appointmentId,locale);
      });
    return reply.status(out.replayed ? 200 : 201).send({
      ...summary, bookingId:out.result.appointmentId, manageToken, replayed:out.replayed,summary,
    });
  });

  // ── 5. 查一条预约（凭令牌）────────────────────────────────────────────────
  app.get<{ Params: { id: string }; Querystring: { t?: string; locale?: string } }>(
    '/public/v1/bookings/:id', async (req) => {
      const shop = await resolveShop(req.headers);
      assertOriginAllowed(originOf(req), shop);
      const locale = localeOf(req.query.locale, shop);

      return withTenant(
        { orgId: shop.orgId, locationId: shop.locationId, membershipId: null },
        async (tx) => {
          const appt = await loadOwnBooking(tx, shop, req.params.id, req.query.t ?? '');
          const items = await tx<{ name: unknown; starts_at: string; duration_min: number }[]>`
            select s.name, ai.starts_at::text as starts_at, ai.duration_min
            from appointment_items ai
            join services s on s.id = ai.service_id
            where ai.appointment_id = ${appt.id} order by ai.seq`;

          return {
            bookingId: appt.id,
            status: appt.status,
            startsAt: appt.starts_at,
            timezone: shop.timezone,
            items: items.map((i) => ({
              name: pickText(i.name, locale),
              startsAt: i.starts_at,
              durationMin: i.duration_min,
            })),
          };
        });
    });

  // ── 6. 自助取消 ───────────────────────────────────────────────────────────
  //
  // ⚠️ 这条**不要求**在线预约开关是开的：老板今天把开关关了，
  // 不该让昨天订了的客人取消不掉 —— 那种客人会直接不来（no-show），
  // 而 no-show 比取消糟得多。
  app.post<{ Params: { id: string }; Body: unknown }>(
    '/public/v1/bookings/:id/cancel', async (req) => {
      const shop = await resolveShop(req.headers);
      assertOriginAllowed(originOf(req), shop, { forWrite: true });

      const parsed = cancelBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new AppError(ERROR_CODES.VALIDATION_FAILED, { details: { reason: 'bad_body' } });
      }

      const verdict = await checkRateLimits(
        [{ scope: 'cancel_ip', id: req.ip, limit: 20, windowSec: 3600 }], req.log);
      if (!verdict.ok) {
        throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
          details: { reason: 'too_many_attempts' },
          messageKey: 'error.TOO_MANY_ATTEMPTS',
        });
      }

      const appt = await withTenant(
        { orgId: shop.orgId, locationId: shop.locationId, membershipId: null },
        (tx) => loadOwnBooking(tx, shop, req.params.id, parsed.data.manageToken));

      // ⚠️ 已经取消了就别再验后四位 —— 幂等的第二次调用不该消耗锁定计数
      if (appt.status !== 'cancelled') {
        await assertLast4(shop, appt, parsed.data.last4);
      }

      if (appt.status === 'cancelled') return { bookingId: appt.id, status: 'cancelled' };

      const cfg = shop.onlineBooking;
      const cancelBlock = guestCancelBlockReason({
        status: appt.status,
        startsAt: appt.starts_at,
        cancelCutoffHours: cfg.cancelCutoffHours,
        rescheduleEnabled: cfg.rescheduleEnabled,
        rescheduleCutoffHours: cfg.rescheduleCutoffHours,
        selfRescheduleMax: cfg.selfRescheduleMax,
        selfRescheduleCount: appt.self_reschedule_count,
      });
      if (cancelBlock) {
        throw new AppError(ERROR_CODES.PERMISSION_DENIED, {
          details: {
            reason: cancelBlock,
            ...(cancelBlock === 'cancel_cutoff_passed'
              ? { cancelCutoffHours: cfg.cancelCutoffHours }
              : {}),
            shopPhone: shop.phone,
          },
        });
      }

      await dispatch('appointment.cancel', {
        appointmentId: appt.id,
        reason: 'guest_changed_mind',
        /**
         * ⭐ `false` 是对的，而且是唯一对的：能走到这里说明离开始还有
         * `cancelCutoffHours` 小时以上，技师根本还没碰这一单，
         * 保留他的轮次等于凭空给他记了一次没干过的活（04 §7）。
         */
        keepStaffTurn: false,
      }, publicContext(shop, shop.defaultLocale, req.ip), {idempotencyKey:`public-cancel:${hashManageToken(parsed.data.manageToken)}`});

      const delivery={orgId:shop.orgId,locationId:shop.locationId,membershipId:null};
      void flushEmails(delivery,req.log);void flushSms(delivery,req.log);
      return { bookingId: appt.id, status: 'cancelled' };
    });

  // ── 7. 自助改期（批 2，docs/13 §4.6）─────────────────────────────────────
  //
  // 初版明确写过「没有自助改期」，理由是「改期在公开页面上会变成
  // 取消 + 重订两步，中间那一格可能被人订走」。那个顾虑是真的 ——
  // 解法不是绕过它，是 `appointment.reschedule` **在一个事务里**
  // 先占新格再放旧格，容量触发器撞了就整体回滚。客人要么改成功，
  // 要么原单原封不动，不存在两头落空的中间态。
  app.post<{ Params: { id: string }; Body: unknown }>(
    '/public/v1/bookings/:id/reschedule', async (req) => {
      const shop = await resolveShop(req.headers);
      assertOriginAllowed(originOf(req), shop, { forWrite: true });

      const cfg = shop.onlineBooking;

      const parsed = rescheduleBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new AppError(ERROR_CODES.VALIDATION_FAILED, { details: { reason: 'bad_body' } });
      }

      const verdict = await checkRateLimits(
        [{ scope: 'reschedule_ip', id: req.ip, limit: 20, windowSec: 3600 }], req.log);
      if (!verdict.ok) {
        throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
          details: { reason: 'too_many_attempts' },
          messageKey: 'error.TOO_MANY_ATTEMPTS',
        });
      }

      const target = new Date(parsed.data.startsAt);
      // 新时间也要过「太急」和「太远」这两道 —— 改期是另一次下单，
      // 不能因为原单合规就让新时间免检
      const aheadMin = (target.getTime() - Date.now()) / 60_000;
      if (aheadMin < cfg.minMinutesAhead) {
        throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
          details: { reason: 'too_soon', minMinutesAhead: cfg.minMinutesAhead,
                     shopPhone: shop.phone },
        });
      }
      const today = businessDateOf(new Date(), shop.timezone, shop.businessDayCutoff);
      const targetDate = businessDateOf(target, shop.timezone, shop.businessDayCutoff);
      if (!isBookableDate(targetDate, today, cfg.maxDaysAhead)) {
        throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
          details: { reason: 'date_out_of_window', maxDaysAhead: cfg.maxDaysAhead },
        });
      }

      const appt = await withTenant(
        { orgId: shop.orgId, locationId: shop.locationId, membershipId: null },
        (tx) => loadOwnBooking(tx, shop, req.params.id, parsed.data.manageToken));

      await assertLast4(shop, appt, parsed.data.last4);

      if(parsed.data.requestId){
        const [replay]=await withTenant({orgId:shop.orgId,locationId:shop.locationId,membershipId:null},tx=>tx`
          select key from command_idempotency where location_id=${shop.locationId}
            and key=${`public-reschedule:${appt.id}:${parsed.data.requestId}`} and command='appointment.reschedule'`);
        if(replay)return {bookingId:appt.id,status:appt.status,startsAt:appt.starts_at,
          rescheduleCountLeft:cfg.selfRescheduleMax>0?Math.max(0,cfg.selfRescheduleMax-appt.self_reschedule_count):null};
      }

      const rescheduleBlock = guestRescheduleBlockReason({
        status: appt.status,
        startsAt: appt.starts_at,
        cancelCutoffHours: cfg.cancelCutoffHours,
        rescheduleEnabled: cfg.rescheduleEnabled,
        rescheduleCutoffHours: cfg.rescheduleCutoffHours,
        selfRescheduleMax: cfg.selfRescheduleMax,
        selfRescheduleCount: appt.self_reschedule_count,
      });
      if (rescheduleBlock === 'already_cancelled') {
        throw new AppError(ERROR_CODES.ALREADY_CANCELLED, {
          details: { bookingId: appt.id, shopPhone: shop.phone },
        });
      }
      if (rescheduleBlock) {
        throw new AppError(ERROR_CODES.PERMISSION_DENIED, {
          details: {
            reason: rescheduleBlock,
            ...(rescheduleBlock === 'reschedule_cutoff_passed'
              ? { rescheduleCutoffHours: cfg.rescheduleCutoffHours }
              : {}),
            ...(rescheduleBlock === 'reschedule_limit_reached'
              ? { selfRescheduleMax: cfg.selfRescheduleMax }
              : {}),
            shopPhone: shop.phone,
          },
        });
      }

      const slotCheck = await withTenant(
        { orgId: shop.orgId, locationId: shop.locationId, membershipId: null },
        (tx) => checkManagedRescheduleSlot(tx, shop, appt.id, target));
      if (!slotCheck.ok) {
        if (slotCheck.kind === 'permission') {
          throw new AppError(ERROR_CODES.PERMISSION_DENIED, {
            details: { reason: slotCheck.reason, shopPhone: shop.phone },
          });
        }
        throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
          details: { reason: slotCheck.reason, shopPhone: shop.phone },
        });
      }

      /**
       * ⚠️ **不传 override**。公开入口永远没有超卖放行 ——
       * 撞了容量就是撞了，让客人换一格，而不是让他把别人挤掉。
       * 这和建单那条路的取舍完全一致（docs/13 §4.2）。
       */
      await dispatch('appointment.reschedule', {
        appointmentId: appt.id,
        startsAt: target.toISOString(),
      }, publicContext(shop, shop.defaultLocale, req.ip), parsed.data.requestId ? {idempotencyKey:`public-reschedule:${appt.id}:${parsed.data.requestId}`} : {});

      // The handler increments the count under the same row/capacity lock.
      const [current]=await withTenant(
        {orgId:shop.orgId,locationId:shop.locationId,membershipId:null},
        tx=>tx<{self_reschedule_count:number}[]>`select self_reschedule_count from appointments where id=${appt.id}`);

      const delivery={orgId:shop.orgId,locationId:shop.locationId,membershipId:null};
      void flushEmails(delivery,req.log);void flushSms(delivery,req.log);
      return {
        bookingId: appt.id,
        status: 'booked',
        startsAt: target.toISOString(),
        rescheduleCountLeft: cfg.selfRescheduleMax > 0
          ? Math.max(0, cfg.selfRescheduleMax - (current?.self_reschedule_count ?? appt.self_reschedule_count + 1)) : null,
      };
    });
}

// ── 内部 ─────────────────────────────────────────────────────────────────────

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0];

/**
 * 项目与加项的时长和价格。价格是服务端可信快照（主项目 + 加项），
 * 通过 `priceCentsOverride` 写入 `appointment_items.price_cents_snapshot`。
 * 公开入口不接受客人传来的价格。
 *
 * ⚠️ 每一个 id 都必须是**本店、在架、且勾了 online_bookable** 的。
 * 老板故意不勾的项目不能通过「知道 id 就能订」的路绕回来（docs/13 §4.2）。
 *
 * ⚠️ 加项在这个数据模型里也是 services 行（价目表提取时 `kind='addon'`
 * 落成的就是普通项目），所以它们走同一条校验 —— 没有「加项目录」这种东西。
 */
async function priceAndDuration(
  tx: Tx, shop: PublicShopRow, serviceId: string, addonIds: readonly string[],
): Promise<{ durationMin: number; priceCents: number }> {
  if (readPublicBookingProfile(shop.settings).services[serviceId]?.visible === false) {
    throw new AppError(ERROR_CODES.NOT_FOUND, {details:{entity:'service'}});
  }
  const ids = [serviceId, ...addonIds];
  const publicAddonIds=Object.entries(readPublicBookingProfile(shop.settings).services).filter(([,v])=>v.visible===true).map(([id])=>id);
  const rows = await tx<{
    id: string; duration_min: number; base_price_cents: number; is_addon: boolean;
  }[]>`
    select id, duration_min, base_price_cents, is_addon from services
    where id = any(${ids as string[]})
      and location_id = ${shop.locationId}
      and active = true and (online_bookable = true or (is_addon and id=any(${publicAddonIds})))`;

  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const id of ids) {
    if (!byId.has(id)) {
      throw new AppError(ERROR_CODES.NOT_FOUND, { details: { serviceId: id } });
    }
  }

  /*
   * ⭐ 加项不能当主项目提交（sql/0035）。
   *
   * 前端已经把它们分开展示了，但**分开展示不是校验** ——
   * 知道 id 就能提交的路必须在服务端堵死，和「没勾在线预约的项目
   * 不能通过知道 id 订回来」是同一条理由（§4.2）。
   *
   * 反过来不拦：主项目挂在 addonIds 上是允许的（「加做一次卸甲」
   * 在真店里就是这么卖的），价格和时长照常累加。
   */
  if (byId.get(serviceId)!.is_addon) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: { reason: 'addon_not_bookable_alone', serviceId },
    });
  }
  return {
    durationMin: ids.reduce((n, id) => n + byId.get(id)!.duration_min, 0),
    priceCents: ids.reduce((n, id) => n + byId.get(id)!.base_price_cents, 0),
  };
}

/** 点钟的那个人必须是本店、在职、可接客的 */
async function assertBookableStaff(tx: Tx, shop: PublicShopRow, membershipId: string): Promise<void> {
  const [row] = await tx<{ ok: boolean }[]>`
    select true as ok from staff_profiles sp
    join memberships m on m.id = sp.membership_id and m.status = 'active'
    where sp.membership_id = ${membershipId}
      and sp.location_id = ${shop.locationId}
      and sp.is_bookable = true`;
  if (!row) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { staffId: membershipId } });
}

/**
 * 防恶意占位的第二道（docs/13 §6.6）。
 *
 * 一家四口一起约**不会**撞上 —— 那是一条预约的 4 个 item，不是 4 条预约。
 * 撞上的基本只有两种人：真的想占位的，和一个填错了一直重订的客人 ——
 * 后者的正确出口也是打电话给店里。
 */
async function assertNotSquatting(tx: Tx, shop: PublicShopRow, phone: string): Promise<void> {
  const [row] = await tx<{ n: number }[]>`
    select count(*)::int as n
    from appointments a
    join customers c on c.id = a.customer_id
    where a.location_id = ${shop.locationId}
      and c.phone_e164 = ${phone}
      and a.status not in ('cancelled', 'completed', 'no_show')
      and a.starts_at > now()`;
  if ((row?.n ?? 0) >= MAX_UPCOMING_PER_PHONE) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: {
        reason: 'too_many_upcoming',
        limit: MAX_UPCOMING_PER_PHONE,
        shopPhone: shop.phone,
      },
    });
  }
}

/**
 * Sources that may receive a guest manage token and therefore must be able
 * to cancel / reschedule through the public routes. Hosted manage-detail
 * lookup does not filter on source; mutations used to, which 404'd desk
 * and phone-manual links after the detail page loaded.
 *
 * Walk-in / kiosk / repeat never mint a manage token, so they stay out.
 */
const GUEST_MANAGE_SOURCES = ['web', 'phone_ai', 'desk', 'phone_manual'] as const;

/**
 * 凭 manage token 取一条预约。
 *
 * ⚠️ 令牌不对、预约不存在、不是这家店的 —— **一律 404，措辞一致**。
 * 区分开来等于告诉试探的人「这个预约 id 是真的，只是令牌错了」。
 */
interface OwnBooking {
  id: string;
  status: string;
  starts_at: string;
  /** 客人留的手机号，用来校验后四位。没留手机号的单是 null */
  phone: string | null;
  self_reschedule_count: number;
}

async function loadOwnBooking(
  tx: Tx, shop: PublicShopRow, id: string, token: string,
): Promise<OwnBooking> {
  const notFound = new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'booking' } });
  if (!/^[0-9a-f-]{36}$/i.test(id) || !token) throw notFound;

  const [row] = await tx<(OwnBooking & { manage_token_digest: string | null })[]>`
    select a.id, a.status, a.starts_at::text as starts_at,
           a.manage_token_digest, a.self_reschedule_count,
           c.phone_e164 as phone
    from appointments a
    left join customers c on c.id = a.customer_id
    where a.id = ${id} and a.location_id = ${shop.locationId}
      and a.source in ${tx(GUEST_MANAGE_SOURCES)}`;

  if (!row?.manage_token_digest) throw notFound;
  if (!sameDigest(row.manage_token_digest, hashManageToken(token))) throw notFound;
  return row;
}

// ── 手机后四位：第二道闸（批 2）──────────────────────────────────────────────

/** 连错几次锁多久。一万种可能里连猜三次就锁，穷举要几十年 */
const LAST4_MAX_FAILS = 3;
const LAST4_LOCK_MS = 15 * 60_000;

/**
 * 校验手机后四位，并维护失败计数。
 *
 * ⚠️ **锁定按预约维度，不按 IP。** 按 IP 锁会让同一个 WiFi 下的第二位客人
 * 被前一位连累（一家店的客人常连同一个 WiFi）；而攻击者要猜的是
 * 「某一条特定预约」的后四位，按预约锁正好卡在他身上。
 *
 * ⚠️ **单子上没有手机号就跳过这一步。** 那种单的 manage URL 不会进确认邮件
 * （见 handlers/appointment.ts），令牌只在建单响应里给过官网一次 ——
 * 风险面和批 2 之前完全一样，没有变大。
 *
 * ⚠️⚠️ **失败计数走自己的事务，不能和调用方共用一个。**
 * 第一版把它写在调用方那个事务里，结果抛异常时连计数一起回滚了 ——
 * 于是 failed_count 永远停在 1，锁定形同虚设，而且测试之外根本看不出来。
 * 「记录一次失败」必须在「拒绝这次请求」之前落地。
 */
async function assertLast4(
  shop: PublicShopRow, appt: OwnBooking, supplied: string | undefined,
): Promise<void> {
  if (!appt.phone) return;

  const tenant = { orgId: shop.orgId, locationId: shop.locationId, membershipId: null };

  // ⚠️ timestamptz 读回来是**字符串**，不是 Date（驱动的行为，全仓一致）——
  // 直接 .getTime() 会在锁定生效的那一刻才炸，平时测不出来
  const [att] = await withTenant(tenant, (tx) => tx<{
    failed_count: number; locked_until: string | Date | null;
  }[]>`
    select failed_count, locked_until from booking_manage_attempts
    where appointment_id = ${appt.id}`);

  const lockedUntilMs = att?.locked_until ? parseTs(att.locked_until).getTime() : 0;
  if (lockedUntilMs > Date.now()) {
    throw new AppError(ERROR_CODES.PERMISSION_DENIED, {
      details: {
        reason: 'last4_locked',
        retryAfterSec: Math.ceil((lockedUntilMs - Date.now()) / 1000),
        shopPhone: shop.phone,
      },
    });
  }

  const want = appt.phone.replace(/\D/g, '').slice(-4);
  // 号码短到取不出四位（脏数据）—— 验不了就不验，而不是把客人锁在门外
  if (want.length < 4) return;

  if (supplied === want) {
    if (att) {
      await withTenant(tenant, (tx) => tx`
        delete from booking_manage_attempts where appointment_id = ${appt.id}`);
    }
    return;
  }

  const failed = (att?.failed_count ?? 0) + 1;
  // ⚠️ 时间参数一律先转成字符串再配 ::timestamptz（见 @gf/db 的 ts() 注释）——
  // 直接丢 Date 进去 postgres 驱动会抛 ERR_INVALID_ARG_TYPE
  const lock = failed >= LAST4_MAX_FAILS ? ts(new Date(Date.now() + LAST4_LOCK_MS)) : null;
  await withTenant(tenant, (tx) => tx`
    insert into booking_manage_attempts
      (appointment_id, org_id, location_id, failed_count, locked_until, last_failed_at)
    values (${appt.id}, ${shop.orgId}, ${shop.locationId}, ${failed},
            ${lock}::timestamptz, now())
    on conflict (appointment_id) do update set
      failed_count = ${failed}, locked_until = ${lock}::timestamptz,
      last_failed_at = now(), updated_at = now()`);

  // ⚠️ 不回「还剩几次」以外的任何信息 —— 尤其不能提示正确答案的长度或首位
  throw new AppError(ERROR_CODES.PERMISSION_DENIED, {
    details: {
      reason: 'last4_mismatch',
      attemptsLeft: Math.max(0, LAST4_MAX_FAILS - failed),
      shopPhone: shop.phone,
    },
  });
}

export { PUBLIC_KEY_HEADER };
