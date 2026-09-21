import { withTenant } from '@gf/db';
import { platformOperationKey } from './idempotency';
/**
 * /v1/platform — GenieFront operator console.
 *
 * Every route independently verifies:
 *   1. authenticated user (req.user from JWT — staff tokens are not enough)
 *   2. active platform_operators row
 *
 * Cross-tenant reads go through sql/0074 SECURITY DEFINER functions.
 * Mutations go through named platform commands + withTenant(target) + audit.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  AppError, ERROR_CODES, PlatformReview10DlcInput, PlatformSetMarketingEmailInput,
} from '@gf/contracts';
import {
  platformDashboardCounts,
  platformSearchStores,
  platformStoreDetail,
  platformMessagingPanel,
  platformListSupportRequests,
  platformSupportRequestDetail,
  platformList10Dlc,
  platform10DlcDetail,
  platformListStorefrontRequests,
  platformStorefrontDetail,
  platformListAudit,
  platformTestInbox,
  platformTestMessage,
  platformListLicenses,
  platformLicensePanel,
} from '@gf/db';
import { stripeClient } from '../stripe/client';
import { assertStripeCustomerBelongsTo } from '../stripe/routes';
import { safeRelativePath } from '../links';
import { deliveryMode } from '../comms/mode';
import { requirePlatformOperator, mapPlatformReadError } from './auth';
import {
  review10DlcForLocation,
  setMarketingEmailForLocation,
  updateSupportRequest,
  addSupportNote,
  updateStorefrontBrief,
  updateStorefrontRevision,
} from './commands';
import {
  issueLicense, revokeLicense, applyLicenseToStore,
  updateStoreLicensePeriod, updateStoreVoiceQuota, revokeStoreLicense, switchStoreToLicense,
} from './licenseCommands';
import { createStoreByOperator } from './storeCommands';

const uuid = z.string().uuid();
const page = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: { issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })) },
    });
  }
  return parsed.data;
}

function platformBaseUrl(): string {
  return (process.env['PLATFORM_BASE_URL'] ?? 'https://ops.geniefront.com').replace(/\/+$/, '');
}

async function operatorFrom(req: FastifyRequest) {
  if (!req.user) throw new AppError(ERROR_CODES.UNAUTHENTICATED);
  return requirePlatformOperator(req.user.userId);
}

async function read<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    mapPlatformReadError(e);
  }
}

export function registerPlatformRoutes(app: FastifyInstance): void {
  app.get('/v1/platform/session', async (req) => {
    const op = await operatorFrom(req);
    return {
      operator: { userId: op.userId, operatorId: op.operatorId, role: op.role, email: op.email },
      // 测试收件箱那一页要靠这两个值解释「为什么这里是空的」：
      // capture 没开的话新消息是真发出去的，收件箱里当然什么都不会新增
      comms: { env: process.env['GF_ENV'] ?? 'unknown', deliveryMode: deliveryMode() },
    };
  });

  app.get('/v1/platform/dashboard', async (req) => {
    const op = await operatorFrom(req);
    return read(() => platformDashboardCounts(op.userId));
  });

  app.get('/v1/platform/stores', async (req) => {
    const op = await operatorFrom(req);
    const q = req.query as Record<string, string | undefined>;
    const paging = parseOrThrow(page, { limit: q['limit'], offset: q['offset'] });
    return read(() => platformSearchStores(op.userId, q['q'] ?? '', paging.limit, paging.offset));
  });

  app.get<{ Params: { locationId: string } }>('/v1/platform/stores/:locationId', async (req) => {
    const op = await operatorFrom(req);
    const locationId = parseOrThrow(uuid, req.params.locationId);
    const detail = await read(() => platformStoreDetail(op.userId, locationId));
    if (!detail) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'location' } });
    return detail;
  });

  app.post<{ Params: { locationId: string }; Body: { returnUrl?: string } }>(
    '/v1/platform/stores/:locationId/billing/portal-session',
    async (req) => {
      const op = await operatorFrom(req);
      const locationId = parseOrThrow(uuid, req.params.locationId);
      const detail = await read(() => platformStoreDetail(op.userId, locationId)) as {
        overview?: { orgId?: string };
        billing?: { stripeCustomerId?: string | null };
      } | null;
      const customerId = detail?.billing?.stripeCustomerId;
      const orgId = detail?.overview?.orgId;
      if (!customerId || !orgId) {
        throw new AppError(ERROR_CODES.NOT_FOUND, { details: { reason: 'stripe_customer_not_found' } });
      }
      /*
       * 运营侧同样核对归属（AUD-02）：核对的是「这个 customer 属不属于
       * 这家店所在的**组织**」，不是「属不属于操作员」。
       *
       * ⚠️ 按 org 而不是按 location —— 多店经营共用同一个 Stripe 客户，
       * 而 customer 的 metadata 指向的是建它的那一家店。按 location 比的话，
       * 运营台点开第二家店时会拿到一个看不懂的 403。
       */
      await assertStripeCustomerBelongsTo(customerId, { orgId, locationId }, req.log);

      const path = safeRelativePath(req.body?.returnUrl, `/stores/${locationId}`);
      try {
        const session = await stripeClient().billingPortal.sessions.create({
          customer: customerId,
          return_url: `${platformBaseUrl()}${path}`,
        });
        return { url: session.url };
      } catch (e) {
        req.log.warn({ err: e }, 'platform portal-session failed');
        throw new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE, {
          details: { service: 'stripe' },
        });
      }
    },
  );

  /**
   * 这家店的外发消息卡在哪一道闸门（只读）。
   *
   * 与门店详情分开一个请求：详情那份是两百行的聚合函数，为两个字段去改它
   * 风险不对等（sql/0089 的文件头）。
   */
  app.get<{ Params: { locationId: string } }>(
    '/v1/platform/stores/:locationId/messaging', async (req) => {
    const op = await operatorFrom(req);
    const locationId = parseOrThrow(uuid, req.params.locationId);
    const panel = await read(() => platformMessagingPanel(op.userId, locationId));
    if (!panel) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'location' } });
    return panel;
  });

  /**
   * 配置完 SES 域名身份与 DNS 之后，用这一条告诉后端「可以发营销邮件了」。
   *
   * ⚠️ 不接受手填地址 —— 服务端会去问 SES 域名验没验过，验过了才写库。
   * 详见 `commands.ts` 的 `setMarketingEmailForLocation`。
   */
  app.post<{ Params: { locationId: string } }>(
    '/v1/platform/stores/:locationId/marketing-email', async (req) => {
    const op = await operatorFrom(req);
    const locationId = parseOrThrow(uuid, req.params.locationId);
    const body = parseOrThrow(
      PlatformSetMarketingEmailInput.omit({ locationId: true }), req.body ?? {});
    if (body.action !== 'disable') throw new AppError(ERROR_CODES.VALIDATION_FAILED, {details:{reason:'marketing_coming_soon'}});
    const panel = await read(() => platformMessagingPanel(op.userId, locationId)) as
      { orgId?: string; slug?: string } | null;
    if (!panel?.orgId || !panel.slug) {
      throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'location' } });
    }
    return setMarketingEmailForLocation(
      op, panel.orgId, panel.slug, { ...body, locationId }, req.ip);
  });

  app.get('/v1/platform/support-requests', async (req) => {
    const op = await operatorFrom(req);
    const q = req.query as Record<string, string | undefined>;
    const paging = parseOrThrow(page, { limit: q['limit'], offset: q['offset'] });
    return read(() => platformListSupportRequests(op.userId, q['status'] ?? null, paging.limit, paging.offset));
  });

  app.get<{ Params: { id: string } }>('/v1/platform/support-requests/:id', async (req) => {
    const op = await operatorFrom(req);
    const id = parseOrThrow(uuid, req.params.id);
    const detail = await read(() => platformSupportRequestDetail(op.userId, id));
    if (!detail) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'support_request' } });
    const request = detail as { orgId: string; locationId: string };
    const messages = await withTenant({ orgId: request.orgId, locationId: request.locationId, membershipId: null, userId: op.userId }, tx => tx`
      select id,body,author_kind as "authorKind",created_at::text as "createdAt" from support_request_messages where request_id=${id} order by created_at,id`);
    return { ...(detail as object), messages };
  });

  app.patch<{ Params: { id: string } }>('/v1/platform/support-requests/:id', async (req) => {
    const op = await operatorFrom(req);
    const id = parseOrThrow(uuid, req.params.id);
    const current = await read(() => platformSupportRequestDetail(op.userId, id)) as {
      orgId?: string; locationId?: string;
    } | null;
    if (!current?.orgId || !current.locationId) {
      throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'support_request' } });
    }
    return updateSupportRequest(
      op, current.orgId, current.locationId,
      { ...(req.body as object), requestId: id },
      req.ip,
    );
  });

  app.post<{ Params: { id: string } }>('/v1/platform/support-requests/:id/notes', async (req) => {
    const op = await operatorFrom(req);
    const id = parseOrThrow(uuid, req.params.id);
    const current = await read(() => platformSupportRequestDetail(op.userId, id)) as {
      orgId?: string; locationId?: string;
    } | null;
    if (!current?.orgId || !current.locationId) {
      throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'support_request' } });
    }
    return addSupportNote(
      op, current.orgId, current.locationId,
      { ...(req.body as object), requestId: id },
      req.ip,
    );
  });

  app.get('/v1/platform/10dlc', async (req) => {
    const op = await operatorFrom(req);
    const q = req.query as Record<string, string | undefined>;
    const paging = parseOrThrow(page, { limit: q['limit'], offset: q['offset'] });
    return read(() => platformList10Dlc(op.userId, q['status'] ?? null, paging.limit, paging.offset));
  });

  app.get<{ Params: { locationId: string } }>('/v1/platform/10dlc/:locationId', async (req) => {
    const op = await operatorFrom(req);
    const locationId = parseOrThrow(uuid, req.params.locationId);
    const detail = await read(() => platform10DlcDetail(op.userId, locationId));
    if (!detail) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'location_10dlc' } });
    return detail;
  });

  app.post<{ Params: { locationId: string } }>('/v1/platform/10dlc/:locationId/review', async (req) => {
    const op = await operatorFrom(req);
    const locationId = parseOrThrow(uuid, req.params.locationId);
    const body = parseOrThrow(PlatformReview10DlcInput.omit({ locationId: true }), req.body ?? {});
    const dlc = await read(() => platform10DlcDetail(op.userId, locationId)) as {
      orgId?: string; locationId?: string;
    } | null;
    if (!dlc?.orgId) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'location_10dlc' } });
    return review10DlcForLocation(op, dlc.orgId, { ...body, locationId }, req.ip);
  });

  app.get('/v1/platform/website-requests', async (req) => {
    const op = await operatorFrom(req);
    const q = req.query as Record<string, string | undefined>;
    const paging = parseOrThrow(page, { limit: q['limit'], offset: q['offset'] });
    return read(() => platformListStorefrontRequests(op.userId, paging.limit, paging.offset));
  });

  app.get<{ Params: { briefId: string } }>('/v1/platform/website-requests/:briefId', async (req) => {
    const op = await operatorFrom(req);
    const briefId = parseOrThrow(uuid, req.params.briefId);
    const detail = await read(() => platformStorefrontDetail(op.userId, briefId));
    if (!detail) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'storefront_brief' } });
    return detail;
  });

  app.post<{ Params: { briefId: string } }>('/v1/platform/website-requests/:briefId/mark-drafted', async (req) => {
    const op = await operatorFrom(req);
    const briefId = parseOrThrow(uuid, req.params.briefId);
    const detail = await read(() => platformStorefrontDetail(op.userId, briefId)) as {
      orgId?: string; locationId?: string;
    } | null;
    if (!detail?.orgId || !detail.locationId) {
      throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'storefront_brief' } });
    }
    return updateStorefrontBrief(op, detail.orgId, detail.locationId, { briefId, action: 'mark_drafted' }, req.ip);
  });

  app.patch<{ Params: { briefId: string; revisionId: string } }>(
    '/v1/platform/website-requests/:briefId/revisions/:revisionId',
    async (req) => {
      const op = await operatorFrom(req);
      const briefId = parseOrThrow(uuid, req.params.briefId);
      const revisionId = parseOrThrow(uuid, req.params.revisionId);
      const detail = await read(() => platformStorefrontDetail(op.userId, briefId)) as {
        orgId?: string; locationId?: string;
      } | null;
      if (!detail?.orgId || !detail.locationId) {
        throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'storefront_brief' } });
      }
      return updateStorefrontRevision(
        op, detail.orgId, detail.locationId,
        { ...(req.body as object), revisionId },
        req.ip,
      );
    },
  );

  /**
   * 测试收件箱（sql/0082）。local / staging 上 capture 下来的邮件与短信。
   *
   * ⭐ 这条接口同时是 E2E 的取件口：跑完一笔下单之后，测试脚本按收件人
   * 查出那封激活信，把 `links[0]` 点开 —— 否则「带链接的邮件」这一整类
   * 流程在自动化里根本走不通。
   *
   * ⚠️ 和其余运营台接口一样受 platform_operators 保护。信里有客人的
   * 邮箱、手机号和一次性链接，这不是一个可以「反正是测试数据」就放开的东西。
   */
  app.get('/v1/platform/test-inbox', async (req) => {
    const op = await operatorFrom(req);
    const q = req.query as Record<string, string | undefined>;
    const paging = parseOrThrow(page, { limit: q['limit'], offset: q['offset'] });
    const channel = parseOrThrow(z.enum(['email', 'sms']).optional(), q['channel'] || undefined);
    return read(() => platformTestInbox(op.userId, {
      channel: channel ?? null,
      status: q['status'] ?? null,
      search: q['search'] ?? null,
      limit: paging.limit ?? 50,
      offset: paging.offset ?? 0,
    }));
  });

  app.get<{ Params: { channel: string; id: string } }>(
    '/v1/platform/test-inbox/:channel/:id',
    async (req) => {
      const op = await operatorFrom(req);
      const channel = parseOrThrow(z.enum(['email', 'sms']), req.params.channel);
      const id = parseOrThrow(uuid, req.params.id);
      const detail = await read(() => platformTestMessage(op.userId, channel, id));
      if (!detail) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'test_message' } });
      return detail;
    },
  );

  app.get('/v1/platform/audit', async (req) => {
    const op = await operatorFrom(req);
    const q = req.query as Record<string, string | undefined>;
    const paging = parseOrThrow(page, { limit: q['limit'], offset: q['offset'] });
    return read(() => platformListAudit(op.userId, {
      locationId: q['locationId'] ?? null,
      command: q['command'] ?? null,
      actorId: q['actorId'] ?? null,
      from: q['from'] ?? null,
      to: q['to'] ?? null,
      limit: paging.limit ?? 50,
      offset: paging.offset ?? 0,
    }));
  });

  // ────────────────────────────────────── 订阅码（sql/0120，计划批 2 / 批 6）

  /**
   * 这家店归哪个 org。
   *
   * ⚠️ 从门店详情里取，而不是让调用方传 org id：接受 org 入参的话
   * 「知道别人的 org id 就能往他家账上挂额度」，而 org id 会出现在日志、
   * 工单和 URL 里（同 `setup.location.create` 不接受 org 入参的理由）。
   */
  const orgOfLocation = async (userId: string, locationId: string): Promise<string> => {
    const detail = await read(() => platformStoreDetail(userId, locationId)) as
      { overview?: { orgId?: string } } | null;
    const orgId = detail?.overview?.orgId;
    if (!orgId) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'location' } });
    return orgId;
  };

  app.get('/v1/platform/licenses', async (req) => {
    const op = await operatorFrom(req);
    const q = req.query as Record<string, string | undefined>;
    const paging = parseOrThrow(page, { limit: q['limit'], offset: q['offset'] });
    return read(() => platformListLicenses(op.userId, {
      status: q['status'] ?? null,
      kind: q['kind'] ?? null,
      query: q['q'] ?? null,
    }, paging.limit ?? 50, paging.offset ?? 0));
  });

  /**
   * 签发一张码。
   *
   * ⭐ 响应体里的 `code` 是**唯一**一次能看到明文的地方 —— 不落库、
   * 不进日志、不进审计。运营要重发给店家只能重新签一张并撤掉旧的。
   */
  app.post('/v1/platform/licenses', async (req) => {
    const op = await operatorFrom(req);
    return issueLicense(op, req.body ?? {});
  });

  app.post<{ Params: { codeId: string } }>(
    '/v1/platform/licenses/:codeId/revoke', async (req) => {
      const op = await operatorFrom(req);
      const codeId = parseOrThrow(uuid, req.params.codeId);
      return revokeLicense(op, { ...(req.body as object ?? {}), codeId });
    },
  );

  app.get<{ Params: { locationId: string } }>(
    '/v1/platform/stores/:locationId/license', async (req) => {
      const op = await operatorFrom(req);
      const locationId = parseOrThrow(uuid, req.params.locationId);
      const panel = await read(() => platformLicensePanel(op.userId, locationId));
      if (!panel) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'location' } });
      return panel;
    },
  );

  /** 定向签发 + 立即生效。等价于把一张码交给店家再替他兑掉 */
  app.post<{ Params: { locationId: string } }>(
    '/v1/platform/stores/:locationId/license/apply', async (req) => {
      const op = await operatorFrom(req);
      const locationId = parseOrThrow(uuid, req.params.locationId);
      const orgId = await orgOfLocation(op.userId, locationId);
      return applyLicenseToStore(op, orgId, locationId, req.body ?? {}, req.ip, platformOperationKey(req.headers['idempotency-key']));
    },
  );

  /**
   * Stripe → 订阅码。**先删这家店在订阅上的那个 item，再挂订阅码。**
   *
   * ⚠️ 与 `/license/apply` 分开一条路：apply 会在这一行还归 Stripe 管时
   * 直接拒绝（权威冲突），而那个拒绝是对的 —— 两个权威同时生效的话，
   * 客户会一边用着订阅码一边被按月扣款。
   */
  app.post<{ Params: { locationId: string } }>(
    '/v1/platform/stores/:locationId/license/switch-from-stripe', async (req) => {
      const op = await operatorFrom(req);
      const locationId = parseOrThrow(uuid, req.params.locationId);
      const orgId = await orgOfLocation(op.userId, locationId);
      return switchStoreToLicense(op, orgId, locationId, req.body ?? {}, req.ip);
    },
  );

  /** 改有效期。`note` 必填（契约层挡） */
  app.patch<{ Params: { locationId: string } }>('/v1/platform/stores/:locationId/voice-quota', async (req) => {
    const op = await operatorFrom(req);
    const locationId = parseOrThrow(uuid, req.params.locationId);
    const orgId = await orgOfLocation(op.userId, locationId);
    return updateStoreVoiceQuota(op, orgId, locationId, req.body ?? {}, req.ip);
  });

  app.patch<{ Params: { locationId: string } }>(
    '/v1/platform/stores/:locationId/license', async (req) => {
      const op = await operatorFrom(req);
      const locationId = parseOrThrow(uuid, req.params.locationId);
      const orgId = await orgOfLocation(op.userId, locationId);
      return updateStoreLicensePeriod(op, orgId, locationId, req.body ?? {}, req.ip, platformOperationKey(req.headers['idempotency-key']));
    },
  );

  /** 立刻收回。改账户，**不动兑换历史** */
  app.post<{ Params: { locationId: string } }>(
    '/v1/platform/stores/:locationId/license/revoke', async (req) => {
      const op = await operatorFrom(req);
      const locationId = parseOrThrow(uuid, req.params.locationId);
      const orgId = await orgOfLocation(op.userId, locationId);
      return revokeStoreLicense(op, orgId, locationId, req.body ?? {}, req.ip);
    },
  );

  /**
   * 运营直接开店（不经 Stripe，计划批 6）。
   *
   * 幂等：同一个店名 + 老板邮箱重复提交返回同一家店，不会建出第二家，
   * 也**不会再挂一次订阅**（见 `storeCommands.ts` 的长注释）。
   */
  app.post('/v1/platform/stores', async (req) => {
    const op = await operatorFrom(req);
    return createStoreByOperator(op, req.body ?? {}, req.log, req.ip);
  });
}
