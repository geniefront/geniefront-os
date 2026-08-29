/**
 * 员工目录查询路由
 *
 * 从 server.ts 拆出。包含：
 * - 员工花名册 (/v1/desk/staff/list, /api/staff/list)
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError, ERROR_CODES } from '@gf/contracts';
import { withTenant } from '@gf/db';
import { loadStaffDirectory } from '../queries/staffList';
import type { CtxFromHeaders } from './utils';

export function registerStaffRoutes(app: FastifyInstance, ctxFromHeaders: CtxFromHeaders): void {
  const handleStaffList = async (req: FastifyRequest) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('staff.manage') && !ctx.permissions.has('appointment.read') && !ctx.permissions.has('ticket.read')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'staff.manage' } });
    }
    return withTenant(ctx, (tx) => loadStaffDirectory(tx, ctx));
  };
  app.get('/v1/desk/staff/list', handleStaffList);
  app.get('/api/staff/list', handleStaffList);
}
