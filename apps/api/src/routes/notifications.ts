/**
 * 应用内通知中心路由
 *
 * 从 server.ts 拆出。包含：
 * - 通知列表查询与分页 (/v1/desk/notifications)
 * - 通知统计数据 (/v1/desk/notifications/stats)
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { withTenant } from '@gf/db';
import {
  loadDeskNotifications, loadDeskNotificationStats,
} from '../queries/notifications';
import type { CtxFromHeaders } from './utils';

export function registerNotificationRoutes(app: FastifyInstance, ctxFromHeaders: CtxFromHeaders): void {
  const handleGetNotifications = async (req: FastifyRequest<{
    Querystring: { category?: string; unreadOnly?: boolean; searchQuery?: string; page?: number; pageSize?: number };
  }>) => {
    const ctx = await ctxFromHeaders(req);
    return withTenant(ctx, (tx) => loadDeskNotifications(tx, ctx, req.query));
  };
  app.get<{ Querystring: { category?: string; unreadOnly?: boolean; searchQuery?: string; page?: number; pageSize?: number } }>(
    '/v1/desk/notifications', handleGetNotifications,
  );
  app.get<{ Querystring: { category?: string; unreadOnly?: boolean; searchQuery?: string; page?: number; pageSize?: number } }>(
    '/api/desk/notifications', handleGetNotifications,
  );

  const handleGetNotificationStats = async (req: FastifyRequest) => {
    const ctx = await ctxFromHeaders(req);
    return withTenant(ctx, (tx) => loadDeskNotificationStats(tx, ctx));
  };
  app.get('/v1/desk/notifications/stats', handleGetNotificationStats);
  app.get('/api/desk/notifications/stats', handleGetNotificationStats);
}
