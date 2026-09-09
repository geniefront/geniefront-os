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
import { checkRateLimits } from '../public/rateLimit';
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

  /**
   * 兑换一张运营签发的订阅码 / 额度包码（sql/0120）。
   *
   * ## ⭐ 必须限频
   *
   * 一张码是「捡到就能用」的凭证。20 位 base32 = 100 bit，暴力猜不动，
   * 但**没有限频的兑换接口本身就是一个可以无限次试的口子** ——
   * 而且每一次失败都要查一次库、拿一次行锁。
   *
   * 两条规则，先便宜的后贵的（顺序有意义，见 `checkRateLimits` 的注释）：
   * 按 IP 每分钟 10 次，按门店每小时 30 次。
   *
   * ## 为什么错误只有一种
   *
   * 不存在 / 已用过 / 已撤销 / 过了兑换期 —— 一律 `code_invalid`
   * （收敛在 `handlers/license.ts` 的 `claimLicense`）。区分开的话，
   * 这个接口就成了一个能拿来枚举码的探针。
   */
  app.post<{ Body: { code?: string } }>(
    '/v1/desk/billing/redeem-code', async (req, reply) => {
      const ctx = await ctxFromHeaders(req);
      if (!ctx.permissions.has('billing.manage')) {
        throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'billing.manage' } });
      }

      const verdict = await checkRateLimits([
        { scope: 'redeem_ip', id: req.ip, limit: 10, windowSec: 60 },
        { scope: 'redeem_location', id: ctx.locationId, limit: 30, windowSec: 3600 },
      ], req.log);
      if (!verdict.ok) {
        // 形状与公开预约那一处一致（`public/routes.ts`）：429 + RATE_LIMITED。
        // ⚠️ 不复用 VALIDATION_FAILED —— 前台要能区分「码不对」和
        // 「你试太快了」，否则店家会一直重试一张本来就对的码
        return reply.status(429).send({
          code: 'RATE_LIMITED',
          messageKey: 'error.RATE_LIMITED',
          details: { scope: verdict.scope, retryAfterSec: verdict.retryAfterSec },
          overridable: false,
        });
      }

      const res = await dispatch('billing.redeemCode', req.body ?? {}, ctx);
      return res.result;
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
