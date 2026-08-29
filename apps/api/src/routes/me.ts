/**
 * 个人中心、门店选择与认领路由
 *
 * 从 server.ts 拆出。包含：
 * - 门店选择器与认领状态 (/v1/me/locations)
 * - 门店上下文与权限 (/v1/me/context)
 * - 个人档案、会话与通知偏好 (/v1/me/profile, /v1/me/sessions, /v1/me/notification-preferences)
 * - 跨店汇总 (/v1/me/summary)
 * - 自助开户门店认领 (/v1/setup/claim)
 */

import type { FastifyInstance } from 'fastify';
import {
  AppError, ERROR_CODES, type CommandContext, type Permission,
} from '@gf/contracts';
import {
  listMembershipsForUser, withTenant, claimableIntentFor,
} from '@gf/db';
import { dispatch } from '../bus';
import { buildContext } from '../actor';
import { loadOrgSummary } from '../queries/orgSummary';
import {
  loadUserProfile, loadUserSessions, loadUserNotificationPreferences,
} from '../queries/profile';
import { staffContextFromToken, STAFF_TOKEN_HEADER } from '../auth/staffSession';
import { todayIso, addDaysIso, type CtxFromHeaders } from './utils';

export function registerMeRoutes(app: FastifyInstance, ctxFromHeaders: CtxFromHeaders): void {

  // ── 个人档案与账号管理 上下文解析 ──────────────────────────────────────────
  async function userCtxFromHeaders(req: { user?: { userId: string }; headers: Record<string, unknown>; ip: string }): Promise<CommandContext> {
    const staffToken = req.headers[STAFF_TOKEN_HEADER];
    if (typeof staffToken === 'string' && staffToken) {
      return staffContextFromToken(staffToken, req.ip);
    }
    if (!req.user) throw new AppError(ERROR_CODES.UNAUTHENTICATED);
    const userId = req.user.userId;
    const headerMembershipId = req.headers['x-membership-id'];
    let targetMembershipId: string | null = null;
    let fallbackOrgId = '00000000-0000-0000-0000-000000000000';
    let fallbackLocationId = '00000000-0000-0000-0000-000000000000';

    if (typeof headerMembershipId === 'string' && headerMembershipId) {
      targetMembershipId = headerMembershipId;
    } else {
      const list = await listMembershipsForUser(userId);
      if (list[0]) {
        targetMembershipId = list[0].membershipId;
        fallbackOrgId = list[0].orgId;
        fallbackLocationId = list[0].locationId;
      }
    }

    if (targetMembershipId) {
      return buildContext({ userId, membershipId: targetMembershipId, ip: req.ip });
    }

    const fallbackCtx: CommandContext = {
      orgId: fallbackOrgId,
      locationId: fallbackLocationId,
      userId,
      membershipId: null,
      permissions: new Set<Permission>(),
      actorKind: 'user',
      locale: 'zh-Hans',
      timezone: 'America/New_York',
      ...(req.ip ? { ip: req.ip } : {}),
    };
    return fallbackCtx;
  }

  // ── 店铺选择器 ───────────────────────────────────────────────────────────
  app.get('/v1/me/locations', async (req) => {
    if (!req.user) throw new AppError(ERROR_CODES.UNAUTHENTICATED, {
      details: { reason: 'requires_platform_account' } });

    const [list, intent] = await Promise.all([
      listMembershipsForUser(req.user.userId),
      claimableIntentFor(req.user.userId),
    ]);

    return {
      locations: list,
      claimable: intent
        ? { locationId: intent.locationId, shopName: intent.shopName, plan: intent.plan }
        : null,
    };
  });

  // ── 我在这家店能干什么 ────────────────────────────────────────────────
  app.get('/v1/me/context', async (req) => {
    const ctx = await ctxFromHeaders(req);
    return {
      membershipId: ctx.membershipId,
      orgId: ctx.orgId,
      locationId: ctx.locationId,
      locale: ctx.locale,
      timezone: ctx.timezone,
      permissions: [...ctx.permissions].sort(),
    };
  });

  app.get('/v1/me/profile', async (req) => {
    const ctx = await userCtxFromHeaders(req);
    return withTenant(ctx, (tx) => loadUserProfile(tx, ctx));
  });

  app.get('/v1/me/sessions', async (req) => {
    const ctx = await userCtxFromHeaders(req);
    return withTenant(ctx, async (tx) => {
      const sessions = await loadUserSessions(tx, ctx, req.ip);
      return { sessions };
    });
  });

  app.get('/v1/me/notification-preferences', async (req) => {
    const ctx = await userCtxFromHeaders(req);
    return withTenant(ctx, (tx) => loadUserNotificationPreferences(tx, ctx));
  });

  // ── 跨店汇总 ────────────────────────────────────────────────────
  app.get<{ Querystring: { from?: string; to?: string; scope?: string } }>(
    '/v1/me/summary', async (req) => {
    if (!req.user) throw new AppError(ERROR_CODES.UNAUTHENTICATED, {
      details: { reason: 'requires_platform_account' } });

    const DATE = /^\d{4}-\d{2}-\d{2}$/;
    const to = DATE.test(req.query.to ?? '') ? req.query.to! : todayIso();
    const from = DATE.test(req.query.from ?? '') ? req.query.from! : addDaysIso(to, -6);
    if (from > to) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, { details: { reason: 'bad_range' } });
    }

    const all = await listMembershipsForUser(req.user.userId);
    const scoped = req.query.scope && req.query.scope !== 'all'
      ? all.filter((m) => m.locationId === req.query.scope)
      : all;

    const REPORT_ROLES = new Set(['owner', 'manager', 'cashier']);
    const allowed = scoped
      .filter((m) => m.roleKeys.some((k) => REPORT_ROLES.has(k)))
      .map((m) => ({ orgId: m.orgId, locationId: m.locationId, membershipId: m.membershipId }));

    return loadOrgSummary(allowed, from, to);
  });

  // ── 认领门店 ──────────────────────────────────────────────────────────
  app.post('/v1/setup/claim', async (req) => {
    if (!req.user) throw new AppError(ERROR_CODES.UNAUTHENTICATED, {
      details: { reason: 'requires_platform_account' } });
    const userId = req.user.userId;
    const intent = await claimableIntentFor(userId);
    if (!intent) {
      throw new AppError(ERROR_CODES.NOT_FOUND, { details: { reason: 'no_claimable_signup' } });
    }

    const ctx: CommandContext = {
      orgId: intent.orgId,
      locationId: intent.locationId,
      userId,
      membershipId: null,
      permissions: new Set<Permission>(['settings.manage']),
      actorKind: 'user',
      locale: 'en',
      timezone: 'UTC',
      ip: req.ip,
    };

    const out = await dispatch<{ membershipId: string; locationId: string; orgId: string }>(
      'setup.claimLocation', { intentId: intent.intentId }, ctx,
      { idempotencyKey: `claim-${intent.intentId}` },
    );
    return out.result;
  });
}
