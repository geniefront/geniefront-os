/**
 * 官网身份：一个 `public_key`，仅此而已（docs/13 §3）。
 *
 * 这是整个系统里**唯一一个不需要任何身份就能写库的入口**。
 * Kiosk 前面站的是客人但至少那台 iPad 是老板亲手配对的；
 * 这里前面站的是**互联网**。所以权限要窄到极致，而且窄法和 Kiosk 不同：
 *
 *   Kiosk  用权限收窄（只有 queue.join + form.submit）
 *   官网   权限上必须有 appointment.write（不然建不出预约），
 *          **于是收窄发生在路由那一层** —— 见下面那段
 *
 * ## ⭐ 为什么给它 appointment.write 是安全的
 *
 * 因为这个上下文**只在 `public/routes.ts` 里被构造出来**，而那里
 * 每一次 dispatch 的入参都是路由自己拼的，不是官网传什么就传什么：
 *
 *   · `source` 恒为 `'web'`
 *   · `override` **永不传** —— 公开入口没有软约束放行。
 *     放行的判断需要一个知道店里现在什么情况的人，而这头没有这个人
 *   · `items` 里的 serviceId 必须是本店 `online_bookable` 的项目
 *   · 价格、时长一律取库里的，官网传的忽略（docs/13 §6.4）
 *   · 时间必须落在 `min_minutes_ahead` / `max_days_ahead` 之内
 *
 * 换句话说：它拿到的不是「前台的写权限」，是「**照着开放时段建一条 web 单**」
 * 这一件事。任何想扩大它的改动，改的是这个文件和 routes.ts，
 * 而这段注释就是给那个人看的。
 *
 * ## 它读不到任何东西
 *
 * 没有 `customer.read`、没有 `appointment.read`、没有 `report.view`。
 * 官网上那些「拉项目 / 拉空档」走的是路由里**写死的窄查询**，
 * 不是给它一个读权限让它自己查（同 Kiosk 签到那条窄路径的道理）。
 */

import {
  AppError, ERROR_CODES,
  type CommandContext, type Locale, type Permission,
} from '@gf/contracts';
import { withPublicKey, withPublicSlug, type PublicShopRow } from '@gf/db';
import { originAllowed, isHostedBookingOrigin } from './origin';

export const PUBLIC_KEY_HEADER = 'x-gf-public-key';

/**
 * 官网这个 actor 的**全部**权限。
 *
 * 加任何一条之前先问：**一个陌生人在浏览器里能拿它干什么？**
 */
export const PUBLIC_BOOKING_PERMISSIONS: readonly Permission[] = [
  'appointment.write',   // 建一条 web 预约（入参由路由拼，见文件头）
  'appointment.cancel',  // 自助取消，凭 manage token（routes.ts 里先验）
];

export interface PublicSession {
  shop: PublicShopRow;
  ctx: CommandContext;
}

const LOCALES = new Set<string>(['en', 'zh-Hans', 'zh-Hant', 'ko', 'vi', 'es']);

/**
 * 认门店。
 *
 * ⚠️ 认不出、停用了、key 格式不对 —— **一律 404**，措辞一致。
 * 区分开来只对想试探的人有用（「这个 key 存在但停用了」是一条信息）。
 */
export async function resolveShop(
  headers: Record<string, unknown>,
  opts: { requireOnlineBooking?: boolean } = {},
): Promise<PublicShopRow> {
  const raw = headers[PUBLIC_KEY_HEADER];
  const key = typeof raw === 'string' ? raw.trim() : '';
  const shop = key ? await withPublicKey(key).catch(() => null) : null;

  if (!shop) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'shop' } });
  if (['suspended', 'closed'].includes(shop.locationStatus)) {
    throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'shop' } });
  }

  /**
   * ⚠️ `setup` 状态的店也进不来：开店向导还没走完，项目和排班可能都是空的。
   * 一条订在空排班上的预约，前台是看不到人的。
   */
  if (shop.locationStatus === 'setup') {
    throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'shop' } });
  }

  if (opts.requireOnlineBooking && !shop.onlineBooking.enabled) {
    throw new AppError(ERROR_CODES.PERMISSION_DENIED, {
      details: { reason: 'online_booking_disabled' },
    });
  }
  return shop;
}

/**
 * Hosted booking bootstrap: slug in the URL, not a public key header.
 * Same 404 envelope as a missing/disabled shop — do not distinguish.
 */
export async function resolveHostedShop(rawSlug: string): Promise<PublicShopRow> {
  const shop = await withPublicSlug(rawSlug).catch(() => null);
  if (!shop) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'shop' } });
  if (['suspended', 'closed', 'setup'].includes(shop.locationStatus)) {
    throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'shop' } });
  }
  return shop;
}

/**
 * 校验来源域名。
 *
 * ⚠️ **没有 Origin 头时放行。** 那说明这不是浏览器的跨源请求 ——
 * 可能是 curl、可能是服务端渲染时拉的项目列表。挡它没有意义：
 * 这张白名单本来就挡不住不带浏览器的人（见 origin.ts 文件头），
 * 而挡了会让老板的 SSR 官网在上线那天整个白屏。
 *
 * ⚠️ **白名单为空时也放行**，但只放行到「能读」。写操作
 * （建单/取消）另外要求白名单非空 —— 老板一条都没填就把
 * 预约表单开出去，等于任何网站都能拿他的 key 建单。
 */
export function assertOriginAllowed(
  origin: string | undefined,
  shop: PublicShopRow,
  opts: { forWrite?: boolean } = {},
): void {
  // ⭐ 我们自己托管的那张预约页先行放过 —— 它跑在我们的域名下，
  // 老板没有理由要把**我们的**域名填进他自己的白名单（origin.ts 有长注释）
  if (isHostedBookingOrigin(origin)) return;

  if (opts.forWrite && shop.allowedOrigins.length === 0 && origin) {
    throw new AppError(ERROR_CODES.PERMISSION_DENIED, {
      details: { reason: 'no_allowed_origins_configured' },
    });
  }
  if (!origin) return;
  if (shop.allowedOrigins.length === 0) return;
  if (originAllowed(origin, shop.allowedOrigins)) return;

  throw new AppError(ERROR_CODES.PERMISSION_DENIED, {
    details: { reason: 'origin_not_allowed' },
  });
}

/** 换一个受限的命令上下文。权限见 PUBLIC_BOOKING_PERMISSIONS 上面那段 */
export function publicContext(shop: PublicShopRow, locale: string, ip?: string): CommandContext {
  return {
    orgId: shop.orgId,
    locationId: shop.locationId,
    // 官网背后没有 user 也没有 membership —— 审计里它是一个系统 actor。
    // 硬塞一个假的 membershipId 会让流水指向一个什么都没做过的真人
    userId: null,
    membershipId: null,
    permissions: new Set(PUBLIC_BOOKING_PERMISSIONS),
    actorKind: 'api',
    locale: (LOCALES.has(locale) ? locale : shop.defaultLocale) as Locale,
    timezone: shop.timezone,
    ...(ip ? { ip } : {}),
  };
}
