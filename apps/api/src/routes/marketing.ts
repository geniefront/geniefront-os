/**
 * 营销中心查询路由
 *
 * 从 server.ts 拆出。包含：
 * - 礼品卡列表及核销预检 (/v1/desk/giftcards, /v1/desk/giftcards/verify)
 * - 次卡套餐 (/v1/desk/packages)
 * - 优惠券 (/v1/desk/coupons)
 * - 会员积分规则 (/v1/desk/loyalty)
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError, ERROR_CODES } from '@gf/contracts';
import { withTenant } from '@gf/db';
import { loadGiftCards, loadGiftCardVerify } from '../queries/giftcard';
import { loadPackages, loadCoupons, loadLoyalty } from '../queries/marketing';
import { scanLegacyPackageCandidates } from '../queries/bundleMigration';
import type { CtxFromHeaders } from './utils';

export function registerMarketingRoutes(app: FastifyInstance, ctxFromHeaders: CtxFromHeaders): void {

  // ── 营销中心：礼品卡 / 次卡套餐 / 优惠券 / 积分 ────────────────────────────
  const handleGiftCards = async (
    req: FastifyRequest<{ Querystring: { status?: string; q?: string; limit?: string; offset?: string } }>,
  ) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('ticket.read') && !ctx.permissions.has('report.view')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'ticket.read' } });
    }
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const offset = req.query.offset ? Number(req.query.offset) : undefined;
    return withTenant(ctx, (tx) => loadGiftCards(tx, ctx, {
      status: req.query.status,
      q: req.query.q,
      limit,
      offset,
    }));
  };
  app.get<{ Querystring: { status?: string; q?: string; limit?: string; offset?: string } }>('/v1/desk/giftcards', handleGiftCards);
  app.get<{ Querystring: { status?: string; q?: string; limit?: string; offset?: string } }>('/v1/desk/marketing/giftcards', handleGiftCards);
  app.get<{ Querystring: { status?: string; q?: string; limit?: string; offset?: string } }>('/v1/desk/marketing/gift-cards', handleGiftCards);

  // 礼品卡即时余额预检接口（收银台使用）
  const handleGiftCardVerify = async (
    req: FastifyRequest<{ Querystring: { code?: string } }>,
  ) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('ticket.read') && !ctx.permissions.has('report.view') && !ctx.permissions.has('ticket.write')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'ticket.read' } });
    }
    const code = req.query.code?.trim();
    if (!code) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, { details: { reason: 'missing_gift_card_code' } });
    }
    return withTenant(ctx, (tx) => loadGiftCardVerify(tx, ctx, code));
  };
  app.get<{ Querystring: { code?: string } }>('/v1/desk/giftcards/verify', handleGiftCardVerify);
  app.get<{ Querystring: { code?: string } }>('/v1/desk/gift-cards/verify', handleGiftCardVerify);

  const handlePackages = async (req: FastifyRequest) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('catalog.manage') && !ctx.permissions.has('ticket.read')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'catalog.manage' } });
    }
    return withTenant(ctx, (tx) => loadPackages(tx, ctx));
  };
  app.get('/v1/desk/packages', handlePackages);
  app.get('/v1/desk/marketing/packages', handlePackages);
  app.get('/api/marketing/packages', handlePackages);

  // 历史次卡模板里疑似「固定组合」的候选扫描（U10 / 计划 P7）——只读，不迁移。
  app.get<{ Querystring: { includePunchcards?: string } }>(
    '/v1/desk/bundles/legacy-scan', async (req) => {
      const ctx = await ctxFromHeaders(req);
      if (!ctx.permissions.has('catalog.manage')) {
        throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'catalog.manage' } });
      }
      return withTenant(ctx, (tx) => scanLegacyPackageCandidates(tx, ctx, {
        includePunchcards: req.query.includePunchcards === 'true',
      }));
    });

  const handleCoupons = async (req: FastifyRequest) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('settings.manage') && !ctx.permissions.has('ticket.read')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'settings.manage' } });
    }
    return withTenant(ctx, (tx) => loadCoupons(tx, ctx));
  };
  app.get('/v1/desk/coupons', handleCoupons);
  app.get('/v1/desk/marketing/coupons', handleCoupons);

  const handleLoyalty = async (req: FastifyRequest) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('settings.manage') && !ctx.permissions.has('ticket.read')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'settings.manage' } });
    }
    return withTenant(ctx, (tx) => loadLoyalty(tx, ctx));
  };
  app.get('/v1/desk/loyalty', handleLoyalty);
  app.get('/v1/desk/marketing/loyalty', handleLoyalty);
}
