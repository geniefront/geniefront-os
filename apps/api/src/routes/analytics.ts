/**
 * 多维经营数据分析路由
 *
 * 从 server.ts 拆出来，原来在 L2154-L2249。
 * 全部需要 `report.view`，只做数据查询，没有写操作。
 */

import type { FastifyInstance } from 'fastify';
import { AppError, ERROR_CODES } from '@gf/contracts';
import { withTenant } from '@gf/db';
import {
  loadRevenueTrends, loadCustomerAnalytics, loadStaffAnalytics,
  loadHeatmap, loadRfmCustomers, loadTopServices, loadCopilotSummary,
} from '../queries/analytics';
import { generateAndSaveBusinessSummary } from '../businessSummary';
import { todayIso, addDaysIso, type CtxFromHeaders } from './utils';

export function registerAnalyticsRoutes(app: FastifyInstance, ctxFromHeaders: CtxFromHeaders): void {

  // ── 多维经营数据分析报表 ──────────────────────────────────────────────────
  app.get<{ Querystring: { from?: string; to?: string } }>(
    '/v1/desk/analytics/revenue-trends', async (req) => {
      const ctx = await ctxFromHeaders(req);
      if (!ctx.permissions.has('report.view')) {
        throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'report.view' } });
      }
      const from = req.query.from || addDaysIso(todayIso(), -30);
      const to = req.query.to || todayIso();
      return withTenant(ctx, (tx) => loadRevenueTrends(tx, ctx, from, to));
    }
  );

  app.get<{ Querystring: { from?: string; to?: string } }>(
    '/v1/desk/analytics/customers', async (req) => {
      const ctx = await ctxFromHeaders(req);
      if (!ctx.permissions.has('report.view')) {
        throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'report.view' } });
      }
      const from = req.query.from || addDaysIso(todayIso(), -30);
      const to = req.query.to || todayIso();
      return withTenant(ctx, (tx) => loadCustomerAnalytics(tx, ctx, from, to));
    }
  );

  app.get<{ Querystring: { from?: string; to?: string } }>(
    '/v1/desk/analytics/staff', async (req) => {
      const ctx = await ctxFromHeaders(req);
      if (!ctx.permissions.has('payroll.view_all') && !ctx.permissions.has('report.view')) {
        throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'report.view' } });
      }
      const from = req.query.from || addDaysIso(todayIso(), -30);
      const to = req.query.to || todayIso();
      return withTenant(ctx, (tx) => loadStaffAnalytics(tx, ctx, from, to));
    }
  );

  app.get<{ Querystring: { from?: string; to?: string } }>(
    '/v1/desk/analytics/heatmap', async (req) => {
      const ctx = await ctxFromHeaders(req);
      if (!ctx.permissions.has('report.view')) {
        throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'report.view' } });
      }
      const from = req.query.from || addDaysIso(todayIso(), -30);
      const to = req.query.to || todayIso();
      return withTenant(ctx, (tx) => loadHeatmap(tx, ctx, from, to));
    }
  );

  app.get<{ Querystring: { from?: string; to?: string } }>(
    '/v1/desk/analytics/rfm-customers', async (req) => {
      const ctx = await ctxFromHeaders(req);
      if (!ctx.permissions.has('report.view')) {
        throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'report.view' } });
      }
      const from = req.query.from || addDaysIso(todayIso(), -90);
      const to = req.query.to || todayIso();
      return withTenant(ctx, (tx) => loadRfmCustomers(tx, ctx, from, to));
    }
  );

  app.get<{ Querystring: { from?: string; to?: string } }>(
    '/v1/desk/analytics/top-services', async (req) => {
      const ctx = await ctxFromHeaders(req);
      if (!ctx.permissions.has('report.view')) {
        throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'report.view' } });
      }
      const from = req.query.from || addDaysIso(todayIso(), -30);
      const to = req.query.to || todayIso();
      return withTenant(ctx, (tx) => loadTopServices(tx, ctx, from, to));
    }
  );

  app.get(
    '/v1/desk/analytics/copilot-summary', async (req) => {
      const ctx = await ctxFromHeaders(req);
      if (!ctx.permissions.has('report.view')) {
        throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'report.view' } });
      }
      return withTenant(ctx, (tx) => loadCopilotSummary(tx, ctx));
    }
  );

  app.post(
    '/v1/desk/analytics/copilot-summary/generate', async (req) => {
      const ctx = await ctxFromHeaders(req);
      if (!ctx.permissions.has('report.view')) {
        throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'report.view' } });
      }
      const apiKey = process.env['ANTHROPIC_API_KEY'];
      if (!apiKey) {
        throw new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE, { details: { service: 'anthropic' } });
      }
      return generateAndSaveBusinessSummary(ctx, apiKey);
    }
  );
}
