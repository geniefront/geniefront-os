/**
 * 硬件终端与设备配对路由
 *
 * 从 server.ts 拆出。包含：
 * - 硬件设备列表 (/v1/desk/hardware/devices)
 * - 配对会话创建与状态轮询 (/v1/desk/pairing/session, /v1/desk/pairing/session/:code/status)
 * - 终端认领配对码 (/v1/public/pairing/claim)
 */

import type { FastifyInstance } from 'fastify';
import { AppError, ERROR_CODES } from '@gf/contracts';
import { withTenant } from '@gf/db';
import { loadHardwareDevices } from '../queries/hardware';
import { createPairingSession, getPairingStatus, claimPairingSession } from '../queries/pairing';
import type { CtxFromHeaders } from './utils';
import { checkRateLimits } from '../public/rateLimit';

export function registerHardwareRoutes(app: FastifyInstance, ctxFromHeaders: CtxFromHeaders): void {

  // ── 硬件终端配对 ───────────────────────────────────────────────────────────
  app.get('/v1/desk/hardware/devices', async (req) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('settings.manage')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'settings.manage' } });
    }
    return withTenant(ctx, (tx) => loadHardwareDevices(tx, ctx));
  });

  app.post<{ Body?: { terminalType?: 'customer-facing' | 'kiosk' } }>(
    '/v1/desk/pairing/session', async (req) => {
      const ctx = await ctxFromHeaders(req);
      if (!ctx.permissions.has('settings.manage')) {
        throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'settings.manage' } });
      }
      return withTenant(ctx, (tx) => createPairingSession(tx, ctx, req.body?.terminalType));
    }
  );

  app.get<{ Params: { code: string } }>(
    '/v1/desk/pairing/session/:code/status', async (req) => {
      const ctx = await ctxFromHeaders(req);
      if (!ctx.permissions.has('settings.manage')) {
        throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'settings.manage' } });
      }
      return withTenant(ctx, (tx) => getPairingStatus(tx, ctx, req.params.code));
    }
  );

  app.post<{ Body?: { code?: string; label?: string } }>(
    '/v1/public/pairing/claim', async (req) => {
      const code = req.body?.code?.trim();
      if (!code) {
        throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
          details: { reason: 'missing_pairing_code' },
        });
      }
      const normalizedCode = code.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
      const verdict = await checkRateLimits([
        { scope: 'pairing_ip', id: req.ip, limit: 20, windowSec: 600 },
        { scope: 'pairing_code', id: normalizedCode, limit: 8, windowSec: 600 },
      ], req.log);
      if (!verdict.ok) {
        throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
          details: { reason: 'too_many_attempts', retryAfterSec: verdict.retryAfterSec },
          messageKey: 'error.TOO_MANY_ATTEMPTS',
        });
      }
      return claimPairingSession(code, req.body?.label);
    }
  );
}
