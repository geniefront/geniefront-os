/**
 * 订阅与计费查询 / 变更路由
 *
 * 从 server.ts 拆出。包含：
 * - 订阅与余额查询及自动充值触发 (/v1/desk/billing)
 * - 变配套餐与购买附加包 (/v1/desk/billing/change-plan, /v1/desk/billing/buy-addon)
 * - 发票记录与税务资料 (/v1/desk/billing/invoices, /v1/desk/billing/tax-profile)
 */

import type { FastifyInstance } from 'fastify';
import { AppError, ERROR_CODES } from '@gf/contracts';
import { withTenant } from '@gf/db';
import { dispatch } from '../bus';
import { loadBilling } from '../queries/billing';
import { loadBillingInvoices, loadTaxProfile } from '../queries/billingInvoices';
import { maybeAutoTopup } from '../billing/autoTopup';
import type { CtxFromHeaders } from './utils';

export function registerBillingRoutes(app: FastifyInstance, ctxFromHeaders: CtxFromHeaders): void {

  // ── 查询：订阅与余额（决策 8）────────────────────────────────────────────
  app.get('/v1/desk/billing', async (req) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('billing.manage')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'billing.manage' } });
    }

    const topup = await Promise.all([
      maybeAutoTopup(ctx, 'credit', req.log),
      maybeAutoTopup(ctx, 'voice_minute', req.log),
    ]);

    const view = await withTenant(
      { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: ctx.membershipId },
      (tx) => loadBilling(tx, ctx));

    return { billing: view, autoTopup: topup };
  });

  // ── SaaS 订阅与算力资源中心 ────────────────────────────────────────────────
  app.post<{ Body: { targetPlan: 'starter' | 'growth' | 'enterprise' | 'essential'; billingCycle?: 'monthly' | 'annual' } }>(
    '/v1/desk/billing/change-plan', async (req) => {
      const ctx = await ctxFromHeaders(req);
      const res = await dispatch('billing.changePlan', req.body, ctx, { systemOrigin: 'billing_route_refusal' });
      return res.result;
    }
  );

  app.post<{ Body: { addonType: 'voice_minutes_100' | 'copilot_credits_500' | 'marketing_sms_1000'; priceCents: number } }>(
    '/v1/desk/billing/buy-addon', async (req) => {
      const ctx = await ctxFromHeaders(req);
      const res = await dispatch('billing.buyAddon', req.body, ctx, { systemOrigin: 'billing_route_refusal' });
      return res.result;
    }
  );

  app.get(
    '/v1/desk/billing/invoices', async (req) => {
      const ctx = await ctxFromHeaders(req);
      if (!ctx.permissions.has('billing.manage') && !ctx.permissions.has('report.view')) {
        throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'billing.manage' } });
      }
      return withTenant(ctx, (tx) => loadBillingInvoices(tx, ctx));
    }
  );

  app.put<{ Body: { legalEntityName: string; taxId: string; billingEmail: string } }>(
    '/v1/desk/billing/tax-profile', async (req) => {
      const ctx = await ctxFromHeaders(req);
      const res = await dispatch('billing.saveTaxProfile', req.body, ctx);
      return res.result;
    }
  );

  app.get(
    '/v1/desk/billing/tax-profile', async (req) => {
      const ctx = await ctxFromHeaders(req);
      if (!ctx.permissions.has('billing.manage') && !ctx.permissions.has('report.view')) {
        throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'billing.manage' } });
      }
      return withTenant(ctx, (tx) => loadTaxProfile(tx, ctx));
    }
  );
}
