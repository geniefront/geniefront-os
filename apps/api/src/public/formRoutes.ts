/**
 * 客人自己填表的那条公开路（`docs/15` §4）。
 *
 * ## 它和别的公开入口不一样在哪
 *
 * | 入口 | 身份是什么 | 前面站的是 |
 * |---|---|---|
 * | 门口 iPad | 老板亲手配的设备令牌 | 客人 |
 * | 门店官网 | 一个人人可见的 `pk_` | 整个互联网 |
 * | **这里** | **一次性的 `fs_` 令牌** | **被邀请的那一个人** |
 *
 * 所以窄法也不同：官网那条要靠 Turnstile + 三维度限频挡住互联网，
 * 这条不需要 —— **没有令牌就什么都没有**，而令牌只发给一个人、
 * 只活 72 小时、填完立刻失效。
 *
 * ## ⚠️ 令牌走 header，不走 query
 *
 * 客人打开的地址是 `…/?t=fs_…`（那是没办法的，二维码里只有一个 URL），
 * 但**前端读完就把它放进请求头**。理由是 query string 会进
 * 反向代理和应用的访问日志 —— 一条能替别人签免责书的凭证不该躺在日志里，
 * 而日志的保留期通常比令牌的 72 小时长得多。
 *
 * ## 它能做的**全部**事情
 *
 *   · 看这条链接点名的那几份表（题目，多语言）
 *   · 交表
 *
 * 查不到客人姓名（只给打码的）、查不到预约、查不到别的表、
 * 更读不到任何已经签过的内容。
 */

import type { FastifyInstance } from 'fastify';
import {
  AppError, ERROR_CODES, pickText,
  type CommandContext, type Locale, type Permission,
} from '@gf/contracts';
import { withTenant, withFormShareToken, type FormShareRow } from '@gf/db';
import { dispatch } from '../bus';
import { hashFormToken } from '../forms/token';
import { maskName } from '../kiosk/routes';
import { checkRateLimits } from './rateLimit';
import '../handlers/kiosk';

const FORM_TOKEN_HEADER = 'x-gf-form-token';

/**
 * 这个 actor 的**全部**权限。加任何一条之前先问：
 * **捡到这条链接的人能拿它干什么？**
 */
const FORM_LINK_PERMISSIONS: readonly Permission[] = ['form.submit'];

const LOCALES = new Set<string>(['en', 'zh-Hans', 'zh-Hant', 'ko', 'vi', 'es']);

interface FormSession {
  link: FormShareRow;
  ctx: CommandContext;
}

/**
 * 认链接。
 *
 * ⚠️ 认不出、过期了、吊销了、已经填完了 —— **一律同一句 410**。
 * 分开报（「过期了」vs「不存在」）对客人没有帮助，对试探的人有。
 * 客人那一页只显示「这个链接不能用了，请联系门店」外加店铺电话。
 */
async function session(
  req: { headers: Record<string, unknown>; ip: string },
  locale?: string,
): Promise<FormSession> {
  const raw = req.headers[FORM_TOKEN_HEADER];
  const token = typeof raw === 'string' ? raw.trim() : '';
  const link = /^fs_[A-Za-z0-9_-]{20,}$/.test(token)
    ? await withFormShareToken(hashFormToken(token)).catch(() => null)
    : null;

  const dead = !link
    || link.revokedAt !== null
    || link.submittedAt !== null
    || new Date(link.expiresAt).getTime() < Date.now()
    || ['suspended', 'closed', 'setup'].includes(link.locationStatus);

  if (dead) {
    throw new AppError(ERROR_CODES.NOT_FOUND, { details: { reason: 'link_unusable' } });
  }

  const l = link!;
  return {
    link: l,
    ctx: {
      orgId: l.orgId,
      locationId: l.locationId,
      // 链接背后没有 user 也没有 membership —— 审计里它是一个系统 actor。
      // 硬塞一个假的会让流水指向一个什么都没做过的真人
      userId: null,
      membershipId: null,
      permissions: new Set(FORM_LINK_PERMISSIONS),
      actorKind: 'api',
      locale: (LOCALES.has(locale ?? '') ? locale : l.locale) as Locale,
      timezone: l.timezone,
      ip: req.ip,
    },
  };
}

export function registerFormLinkRoutes(app: FastifyInstance): void {
  // ── 1. 这条链接要我签什么 ─────────────────────────────────────────────
  app.get<{ Querystring: { locale?: string } }>('/public/v1/forms', async (req) => {
    const { link, ctx } = await session(req, req.query.locale);

    /**
     * ⚠️ 限频按**令牌**算，不按 IP：一条链接就一个人在用，
     * 他刷新十次是正常的，刷一百次不是。按 IP 算会误伤
     * 同一个 WiFi 下的一家人（很常见：太太先填，先生接着填）。
     */
    const verdict = await checkRateLimits(
      [{ scope: 'form_token', id: link.id, limit: 60, windowSec: 3600 }], req.log);
    if (!verdict.ok) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
        details: { reason: 'too_many_attempts' },
        messageKey: 'error.TOO_MANY_ATTEMPTS',
      });
    }

    return withTenant(
      { orgId: link.orgId, locationId: link.locationId, membershipId: null },
      async (tx) => {
        const rows = link.templateIds.length > 0
          ? await tx<{
              id: string; key: string; version: number; title: unknown;
              schema: unknown; requires_signature: boolean;
            }[]>`
              select id, key, version, title, schema, requires_signature
              from form_templates
              where location_id = ${link.locationId} and id in ${tx(link.templateIds)}
              order by created_at`
          : [];

        // 哪几份他已经在**这条**链接里签掉了 —— 刷新之后不该从头再来一遍
        const done = await tx<{ template_id: string }[]>`
          select distinct template_id from form_submissions
          where location_id = ${link.locationId} and share_link_id = ${link.id}`;
        const doneIds = new Set(done.map((d) => d.template_id));

        const [line] = await tx<{ e164: string }[]>`
          select e164 from phone_lines
          where location_id = ${link.locationId} and purpose = 'main' and active limit 1`;

        const [cust] = link.customerId
          ? await tx<{ display_name: string }[]>`
              select display_name from customers where id = ${link.customerId}`
          : [];

        return {
          shopName: pickText(link.shopName, ctx.locale, ''),
          /**
           * 前台发的时候选的那一种。客人那一页拿它当**默认值** ——
           * 他随时能在上面那一排改，而他最后看的那一种会跟着提交记录存下来
           */
          locale: link.locale,
          shopPhone: line?.e164 ?? link.shopPhone,
          /**
           * ⚠️ 只给**打码的**名字（同门口签到那条窄路径）。
           * 客人要能确认「这张表是发给我的」，而捡到链接的人
           * 不该因此知道这家店有一位叫什么的客人。
           */
          maskedName: cust ? maskName(cust.display_name) : null,
          expiresAt: new Date(link.expiresAt).toISOString(),
          forms: rows.map((r) => ({
            templateId: r.id,
            key: r.key,
            version: r.version,
            // i18n 整份给出去 —— 客人在自己手机上还可以再换语言（宪法第 7 条）
            title: r.title,
            // 隐藏题仍在版本快照中，但绝不能下发给顾客端。
            questions: Array.isArray(r.schema)
              ? r.schema.filter((q) => !q || typeof q !== 'object' || !(q as { hidden?: boolean }).hidden)
              : [],
            requiresSignature: r.requires_signature,
            done: doneIds.has(r.id),
          })),
        };
      });
  });

  // ── 2. 交一份 ─────────────────────────────────────────────────────────
  app.post<{ Body: Record<string, unknown> }>('/public/v1/forms/submit', async (req) => {
    const body = req.body ?? {};
    const { link, ctx } = await session(req, body['locale'] as string | undefined);

    const verdict = await checkRateLimits(
      [{ scope: 'form_submit', id: link.id, limit: 20, windowSec: 3600 }], req.log);
    if (!verdict.ok) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
        details: { reason: 'too_many_attempts' },
        messageKey: 'error.TOO_MANY_ATTEMPTS',
      });
    }

    const templateId = String(body['templateId'] ?? '');
    // ⚠️ **只认这条链接点名的那几份**。不查一遍的话，拿到一条合法链接的人
    // 能替这家店的任何一份模板伪造一条签名记录
    if (!link.templateIds.includes(templateId)) {
      throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'form_template' } });
    }

    const out = await dispatch<{ submissionId: string; expiresOn: string | null }>(
      'form.submit',
      {
        ...body,
        // ⭐ 客人是谁由**链接**决定，不由请求体决定 —— 让请求体说了算的话，
        // 一条链接就能往任意一位客人名下挂一份健康表
        customerId: link.customerId,
        appointmentId: link.appointmentId,
        source: 'link',
        // ⭐ 出处。它同时是「还剩几份没填」的依据 —— 见下面那段
        shareLinkId: link.id,
      },
      ctx,
      // 客人手机上的网络是最差的一种。重试不能变成两份签名
      { idempotencyKey: `formlink-${link.id}-${templateId}` },
    );

    // 全部签完就把链接封掉。⚠️ 在同一个租户上下文里做，不走令牌那条策略
    const remaining = await withTenant(
      { orgId: link.orgId, locationId: link.locationId, membershipId: null },
      async (tx) => {
        /**
         * ⚠️ **按 `share_link_id` 算，不要按 (customer_id, 时间) 去凑。**
         *
         * 匿名链接的 customer_id 是 null，而 `null is not distinct from null`
         * 为真 —— 两条匿名链接同时在外面时，A 填完会把 B 也算成填完了，
         * 于是 B 那位客人下次点开只看到一句「这个链接不能用了」。
         */
        const done = await tx<{ template_id: string }[]>`
          select distinct template_id from form_submissions
          where location_id = ${link.locationId} and share_link_id = ${link.id}`;
        const doneIds = new Set(done.map((d) => d.template_id));
        const left = link.templateIds.filter((id) => !doneIds.has(id));
        if (left.length === 0) {
          await tx`update form_share_links set submitted_at = now() where id = ${link.id}`;
        }
        return left.length;
      });

    return { submissionId: out.result.submissionId, remaining, done: remaining === 0 };
  });
}
