/**
 * 订单与电子小票路由
 *
 * 从 server.ts 拆出。包含：
 * - 全量订单多维筛选与分页 (/v1/desk/orders)
 * - 电子小票快捷补发 (/v1/desk/tickets/:id/send-receipt)
 */

import type { FastifyInstance } from 'fastify';
import { AppError, ERROR_CODES } from '@gf/contracts';
import { withTenant } from '@gf/db';
import { dispatch } from '../bus';
import { loadOrders } from '../queries/orders';
import type { CtxFromHeaders } from './utils';

export function registerOrdersRoutes(app: FastifyInstance, ctxFromHeaders: CtxFromHeaders): void {

  // ── 全量订单多维筛选与分页 ─────────────────────────────────────────────────
  app.get<{
    Querystring: {
      status?: string;
      from?: string;
      to?: string;
      staffId?: string;
      paymentMethod?: string;
      minAmount?: string;
      maxAmount?: string;
      q?: string;
      limit?: string;
      offset?: string;
    };
  }>('/v1/desk/orders', async (req) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('ticket.read') && !ctx.permissions.has('report.view')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'ticket.read' } });
    }
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const offset = req.query.offset ? Number(req.query.offset) : undefined;
    const minAmount = req.query.minAmount ? Number(req.query.minAmount) : undefined;
    const maxAmount = req.query.maxAmount ? Number(req.query.maxAmount) : undefined;

    return withTenant(ctx, (tx) => loadOrders(tx, ctx, {
      status: req.query.status,
      from: req.query.from,
      to: req.query.to,
      staffId: req.query.staffId,
      paymentMethod: req.query.paymentMethod,
      minAmount,
      maxAmount,
      q: req.query.q,
      limit,
      offset,
    }));
  });

  // ── 电子小票快捷补发 ───────────────────────────────────────────────────────
  app.post<{
    Params: { id: string };
    Body?: { channel?: 'sms' | 'email'; destination?: string };
  }>('/v1/desk/tickets/:id/send-receipt', async (req) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('ticket.write')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'ticket.write' } });
    }
    return dispatch(
      'ticket.sendReceipt',
      {
        ticketId: req.params.id,
        channel: req.body?.channel ?? 'sms',
        destination: req.body?.destination,
      },
      ctx,
    );
  });
}
