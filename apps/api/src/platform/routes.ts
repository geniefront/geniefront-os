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
import { AppError, ERROR_CODES, PlatformReview10DlcInput } from '@gf/contracts';
import {
  platformDashboardCounts,
  platformSearchStores,
  platformStoreDetail,
  platformListSupportRequests,
  platformSupportRequestDetail,
  platformList10Dlc,
  platform10DlcDetail,
  platformListStorefrontRequests,
  platformStorefrontDetail,
  platformListAudit,
} from '@gf/db';
import { stripeClient } from '../stripe/client';
import { assertStripeCustomerBelongsTo } from '../stripe/routes';
import { safeRelativePath } from '../stripe/returnUrl';
import { requirePlatformOperator, mapPlatformReadError } from './auth';
import {
  review10DlcForLocation,
  updateSupportRequest,
  addSupportNote,
  updateStorefrontBrief,
  updateStorefrontRevision,
} from './commands';

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
    return { operator: { userId: op.userId, operatorId: op.operatorId, role: op.role, email: op.email } };
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
      if (!customerId) {
        throw new AppError(ERROR_CODES.NOT_FOUND, { details: { reason: 'stripe_customer_not_found' } });
      }
      // 运营侧同样核对归属（AUD-02）：这里的 locationId 是操作员点开的那家店，
      // 核对的是「这个 customer 属不属于那家店」，不是「属不属于操作员」。
      await assertStripeCustomerBelongsTo(customerId, locationId, req.log);

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
    return detail;
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
}
