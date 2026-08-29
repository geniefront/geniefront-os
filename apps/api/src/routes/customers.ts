/**
 * 客户档案与搜索路由
 *
 * 从 server.ts 拆出。包含：
 * - 客户快捷搜索 (/v1/customers/search)
 * - 客户详情档案 (/v1/desk/customers/:id)
 * - 客户列表与高级筛选 (/v1/desk/customers, /api/customers/list)
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError, ERROR_CODES } from '@gf/contracts';
import { withTenant } from '@gf/db';
import { loadCustomerDetail, loadCustomerList } from '../queries/customer';
import type { CtxFromHeaders } from './utils';

interface CustomerRow {
  id: string; display_name: string; phone_e164: string | null;
  no_show_count: number; tags: string[] | null; last_visit_on: string | null;
}

export function registerCustomersRoutes(app: FastifyInstance, ctxFromHeaders: CtxFromHeaders): void {

  // ── 查询：找客人 ───────────────────────────────────────────────────────────
  app.get<{ Querystring: { q?: string } }>('/v1/customers/search', async (req) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('customer.read')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'customer.read' } });
    }

    const raw = (req.query.q ?? '').trim();
    if (raw.length < 2) return { customers: [] };

    const digits = raw.replace(/\D/g, '');
    const byPhone = digits.length >= 3;
    const canSeeContact = ctx.permissions.has('customer.view_contact');

    const rows = await withTenant(
      { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: ctx.membershipId },
      (tx) => byPhone
        ? tx<CustomerRow[]>`
            select c.id, c.display_name, c.phone_e164, c.no_show_count, c.tags,
                   (select max(a.business_date)::text from appointments a
                     where a.customer_id = c.id and a.status <> 'cancelled') as last_visit_on
            from customers c
            where c.merged_into_id is null
              and regexp_replace(coalesce(c.phone_e164,''), '\\D', '', 'g') like ${'%' + digits}
            order by c.display_name limit 20`
        : tx<CustomerRow[]>`
            select c.id, c.display_name, c.phone_e164, c.no_show_count, c.tags,
                   (select max(a.business_date)::text from appointments a
                     where a.customer_id = c.id and a.status <> 'cancelled') as last_visit_on
            from customers c
            where c.merged_into_id is null and c.display_name ilike ${'%' + raw + '%'}
            order by c.display_name limit 20`,
    );

    return {
      customers: rows.map((r) => ({
        id: r.id,
        displayName: r.display_name,
        phoneE164: canSeeContact
          ? r.phone_e164
          : r.phone_e164 ? `***${r.phone_e164.slice(-4)}` : null,
        lastVisitOn: r.last_visit_on,
        lastStaffName: null,
        noShowCount: r.no_show_count,
        tags: r.tags ?? [],
      })),
    };
  });

  // ── 客户档案详情 ──────────────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>('/v1/desk/customers/:id', async (req) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('customer.read')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'customer.read' } });
    }
    const detail = await withTenant(
      { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: ctx.membershipId },
      (tx) => loadCustomerDetail(tx, ctx, req.params.id));
    if (!detail) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'customer' } });
    return detail;
  });

  const handleCustomers = async (req: FastifyRequest<{ Querystring: {
    q?: string; query?: string; filterType?: any; vip?: string; sleeping?: string; limit?: string; offset?: string;
  } }>) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('customer.read')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'customer.read' } });
    }
    const int = (v: string | undefined) => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
    };
    return withTenant(
      { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: ctx.membershipId },
      (tx) => loadCustomerList(tx, ctx, {
        ...(req.query.query ? { query: req.query.query } : {}),
        ...(req.query.q ? { q: req.query.q } : {}),
        ...(req.query.filterType ? { filterType: req.query.filterType } : {}),
        vipOnly: req.query.vip === '1',
        ...(int(req.query.sleeping) ? { sleepingDays: int(req.query.sleeping)! } : {}),
        ...(int(req.query.limit) ? { limit: int(req.query.limit)! } : {}),
        ...(int(req.query.offset) ? { offset: int(req.query.offset)! } : {}),
      }));
  };

  app.get('/v1/desk/customers', handleCustomers);
  app.get('/api/customers/list', handleCustomers);
}
