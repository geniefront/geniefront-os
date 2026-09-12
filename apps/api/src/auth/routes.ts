import { issuePhoneSelection, verifyPhoneSelection, redeemPhoneSelection } from './phoneSelection';
/**
 * 技师上机的三条路由（sql/0031、docs/09 §5）
 *
 * 这三条和系统里别的路由有一个根本区别：**它们在认证之前**。
 * 打进来的人还什么都不是，所以每一条都要自己回答一遍
 * 「伪造这一次请求的人能拿到什么」。
 *
 *   POST /v1/auth/staff/claim-code   老板念的 6 位码 → 会话   ← 不依赖短信
 *   POST /v1/auth/phone/start        给店里认识的号码发验证码
 *   POST /v1/auth/phone/verify       验证码 → 会话
 *
 * ## 两条共同的纪律
 *
 * 1. **不泄露「这个号码/这个人是不是店里的」。** 号码不在花名册上时，
 *    返回的东西和在的时候一模一样 —— 否则这就成了一个「拿号码探测
 *    某人在哪家店上班」的接口（和 Kiosk 签到那条同一个判断）。
 * 2. **限频**。6 位码只有一百万种，而短信是花钱的。
 *    限频用进程内的 Map（宪法第 10 条：不为这个引入 Redis）——
 *    两台实例各限一半，对「一分钟内试几百次」这种量级足够了。
 */

import type { FastifyInstance } from 'fastify';
import { AppError, ERROR_CODES, normalizePhoneE164, pickText, type Locale } from '@gf/contracts';
import { redeemStaffClaimCode, staffByPhone, withTenant } from '@gf/db';
import { claimCodeHash } from '../handlers/staff';
import { issueStaffSession, staffContextFromToken, STAFF_TOKEN_HEADER } from './staffSession';
import { sendPhoneCode, checkPhoneCode, verifyConfigured } from './phoneOtp';

/**
 * 进程内限频。
 *
 * 和 kiosk/routes.ts 那份是同一个套路，**故意各写一份而不是抽公用** ——
 * 两处的窗口和阈值是按各自的滥用方式定的（这里防的是猜码和刷短信费，
 * 那边防的是拿手机号试客人），抽成一个函数之后调参数会互相牵扯。
 */
const HITS = new Map<string, { count: number; resetAt: number }>();

/**
 * 硬上界：超过这个大小就触发一次紧急清理。
 * 防止攻击者用大量不同 IP / 手机号把 Map 撑爆内存。
 */
const MAX_HITS_ENTRIES = 10_000;

/**
 * 每 5 分钟清理一次过期条目。
 * `.unref()` 保证定时器不会阻止进程正常退出。
 */
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of HITS) {
    if (now > v.resetAt) HITS.delete(k);
  }
}, 5 * 60_000).unref();

function limit(key: string, max: number, windowMs: number): void {
  const now = Date.now();

  // 紧急清理：超出硬上界时先把过期的删掉，腾出空间
  if (HITS.size >= MAX_HITS_ENTRIES) {
    for (const [k, v] of HITS) { if (now > v.resetAt) HITS.delete(k); }
  }

  const cur = HITS.get(key);
  if (!cur || now > cur.resetAt) {
    HITS.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }
  if (++cur.count > max) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: { reason: 'too_many_attempts' },
    });
  }
}

const LOCALES = ['en', 'zh-Hans', 'zh-Hant', 'ko', 'vi', 'es'] as const;
const asLocale = (v: unknown): Locale | undefined =>
  (LOCALES as readonly string[]).includes(v as string) ? (v as Locale) : undefined;

export function registerAuthRoutes(app: FastifyInstance): void {

  // ── ① 上机码：不依赖短信的那条路 ─────────────────────────────────────────
  //
  // 老板在员工页点「生成上机码」，屏幕上出现 6 位数字，念给技师。
  //
  // ⚠️ 6 位数字的强度全靠**限频 + 15 分钟时效 + 一次性**这三条一起兜。
  // 单看「摘要存库」是不够的：一百万种可以离线全跑一遍，
  // 所以数据库那边的函数是「查到即作废」（sql/0031 §5）。
  app.post<{ Body: { code?: string; deviceLabel?: string } }>(
    '/v1/auth/staff/claim-code', async (req) => {
    const code = (req.body?.code ?? '').replace(/\D/g, '');
    if (code.length !== 6) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, { details: { reason: 'code_format' } });
    }
    // 一个 IP 一分钟 5 次：老板念错一两次很正常，试三十次不是
    limit(`claim:${req.ip}`, 5, 60_000);
    // 全平台全局：每分钟最多 100 次兑换尝试，防分布式代理绕过单 IP 限制
    limit('claim:global', 100, 60_000);

    /**
     * 码不按门店加盐 —— 输码的人不知道自己在哪家店，兑换这一侧
     * 没有门店可以拿来算摘要。「两家店同时发出同一个码」这件事
     * 由数据库的唯一索引堵死（sql/0031），不是靠概率。
     */
    const match = await redeemStaffClaimCode(claimCodeHash(code));
    if (!match) {
      // 不区分「码不对」和「码过期了」：对输码的人来说，
      // 要做的事都是「让老板再点一次」。
      // ⚠️ 失败加 500ms 延迟：让每轮暴力猜码的实际速率上限约 2 次/秒/IP，
      // 即使绕过了计数器也无法在 15 分钟窗口内穷举百万种组合。
      await new Promise((r) => setTimeout(r, 500));
      throw new AppError(ERROR_CODES.UNAUTHENTICATED, { details: { reason: 'bad_claim_code' } });
    }

    const session = await issueStaffSession(
      match, 'claim_code', (req.body?.deviceLabel ?? '').slice(0, 40) || null);
    return { ...session, ...(await whoAmI(match)) };
  });


  // ── ② 发验证码 ───────────────────────────────────────────────────────────
  app.post<{ Body: { phone?: string; locale?: string } }>('/v1/auth/phone/start', async (req) => {
    const phone = normalizePhoneE164(req.body?.phone ?? '');
    if (!phone) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, { details: { reason: 'phone_format' } });
    }
    if (!verifyConfigured()) {
      // 没配 Verify Profile 就明确说不可用 —— 而不是假装发了
      throw new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE, {
        details: { service: 'telnyx_verify', reason: 'not_configured' },
      });
    }

    // 一个号码 5 分钟 3 条（重发是正常的）；一个 IP 一分钟 5 次
    limit(`otp-phone:${phone}`, 3, 5 * 60_000);
    limit(`otp-ip:${req.ip}`, 5, 60_000);

    const found = await staffByPhone(phone);

    /**
     * ⭐ **只给花名册上的号码发短信。**
     *
     * 不挡的话这就是一个「给任意号码发短信」的接口：既是我们出钱，
     * 又是一个能被拿去骚扰别人的东西。
     *
     * 但**回给客户端的东西一模一样** —— 否则输一串号码就能问出
     * 「这个人是不是在这家店上班」。
     */
    if (found.length > 0) {
      /**
       * ⭐ 短信用**他手机上那个界面的语言**发。
       *
       * 他还没登录，所以语言只能由客户端告诉我们 —— 这是这条链路上
       * 唯一一处「听客户端的」，而它的最坏后果只是收到一条英文短信。
       * 越南语技师收到越南语的验证码，这件事值得为它多传一个字段。
       */
      await sendPhoneCode(phone, asLocale(req.body?.locale));
    } else {
      req.log.info({ phone }, 'phone otp requested for unknown number');
    }
    return { ok: true, sent: true };
  });

  // ── ③ 验码换会话 ─────────────────────────────────────────────────────────
  app.post<{ Body: { phone?: string; code?: string; selectionToken?: string; locationId?: string; deviceLabel?: string } }>(
    '/v1/auth/phone/verify', async (req) => {
    const selection = req.body?.selectionToken ? await verifyPhoneSelection(req.body.selectionToken) : null;
    const phone = selection?.phone ?? normalizePhoneE164(req.body?.phone ?? '');
    if (selection && req.body?.phone && normalizePhoneE164(req.body.phone) !== phone) {
      throw new AppError(ERROR_CODES.UNAUTHENTICATED);
    }
    const code = (req.body?.code ?? '').replace(/\D/g, '');
    if (!phone || (!selection && code.length < 4)) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, { details: { reason: 'bad_input' } });
    }
    limit(`otp-verify:${phone}`, 8, 5 * 60_000);
    limit(`otp-verify-ip:${req.ip}`, 20, 60_000);

    const ok = selection !== null || await checkPhoneCode(phone, code);
    if (!ok) {
      throw new AppError(ERROR_CODES.UNAUTHENTICATED, { details: { reason: 'bad_code' } });
    }

    /**
     * 码对了才去花名册里找人。
     *
     * ⚠️ 顺序不能反：先查花名册的话，「这个号码在不在」会从
     * 响应时间里漏出去，而这一条恰恰是上面费劲藏起来的东西。
     */
    const found = (await staffByPhone(phone)).filter(f => !selection || selection.memberships.includes(f.membershipId));
    if (found.length === 0) {
      // 码是真的，但这个号码不属于任何在岗员工 —— 多半是他离职了
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, {
        details: { reason: 'not_on_any_roster' },
      });
    }

    /**
     * 一个技师在两家店上班就有两条 —— 这是常态，不是异常。
     * 前端先拿到列表让他点一家，再带 `locationId` + `selectionToken` 来换令牌
     * （和多店老板的选店器是同一件事）。
     */
    const picked = req.body?.locationId
      ? found.find((f) => f.locationId === req.body!.locationId)
      : (found.length === 1 ? found[0] : undefined);

    if (!picked) {
      return {
        needsLocation: true,
        selectionToken: selection ? req.body.selectionToken : await issuePhoneSelection(phone, found),
        locations: await Promise.all(found.map((f) => whoAmI(f))),
      };
    }

    const label = (req.body?.deviceLabel ?? '').slice(0, 40) || null;
    const session = selection
      ? await redeemPhoneSelection(selection, picked, label)
      : await issueStaffSession(picked, 'phone_otp', label);
    return { ...session, ...(await whoAmI(picked)) };
  });

  // ── 我是谁（技师端启动时先问一句）───────────────────────────────────────
  app.get('/v1/auth/staff/me', async (req) => {
    const ctx = await staffContextFromToken(
      req.headers[STAFF_TOKEN_HEADER] as string | undefined, req.ip);
    return {
      membershipId: ctx.membershipId,
      locationId: ctx.locationId,
      displayName: pickText(ctx.displayName, ctx.locale),
      locale: ctx.locale,
      permissions: [...ctx.permissions],
    };
  });

  /** 给前端一句「你是哪家店的谁」。会话已经建立，所以这里可以说真名 */
  async function whoAmI(t: { orgId: string; locationId: string; membershipId: string }): Promise<{
    membershipId: string; locationId: string; shopName: string; displayName: string;
  }> {
    const rows = await withTenant(
      { orgId: t.orgId, locationId: t.locationId, membershipId: null },
      (tx) => tx<{ shop: unknown; name: unknown; locale: string | null }[]>`
        select l.name as shop, sp.display_name as name, sp.locale
        from staff_profiles sp
        join locations l on l.id = sp.location_id
        where sp.membership_id = ${t.membershipId}`);
    const r = rows[0];
    const locale = (r?.locale ?? 'en') as Parameters<typeof pickText>[1];
    return {
      membershipId: t.membershipId,
      locationId: t.locationId,
      shopName: pickText(r?.shop ?? {}, locale),
      displayName: pickText(r?.name ?? {}, locale),
    };
  }
}
