/**
 * 口碑聚合与 AI Review 总结路由
 *
 * 从 server.ts 拆出。包含：
 * - 评价摘要与分析 (/v1/desk/reviews/summary, /v1/desk/analytics/reviews-summary)
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError, ERROR_CODES } from '@gf/contracts';
import { withTenant } from '@gf/db';
import { loadReviewsSummary } from '../queries/reviews';
import type { CtxFromHeaders } from './utils';

export function registerReviewsRoutes(app: FastifyInstance, ctxFromHeaders: CtxFromHeaders): void {
  const handleReviewsSummary = async (req: FastifyRequest) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('report.view') && !ctx.permissions.has('ticket.read')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'report.view' } });
    }
    return withTenant(ctx, (tx) => loadReviewsSummary(tx, ctx));
  };
  app.get('/v1/desk/reviews/summary', handleReviewsSummary);
  app.get('/v1/desk/analytics/reviews-summary', handleReviewsSummary);
}
