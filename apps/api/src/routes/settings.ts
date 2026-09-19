/**
 * 门店设置与系统配置路由
 *
 * 从 server.ts 拆出。包含：
 * - 基础设置 (/v1/desk/settings)
 * - 门店资料与营业时间 (/v1/desk/settings/location, /v1/desk/settings/business-hours)
 * - 结账规则 (/v1/desk/settings/checkout)
 * - 在线预约规则 (/v1/desk/settings/online-booking)
 * - 员工资料与轮牌偏好 (/v1/desk/settings/staff/*)
 * - AI 电话助理 (/v1/desk/settings/phone-assistant)
 * - 10DLC 短信合规 (/v1/desk/settings/10dlc/*)
 * - 硬件免责声明 (/v1/desk/settings/hardware/intake-waiver)
 * - Webhook 配置 (/v1/desk/settings/webhooks)
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError, ERROR_CODES } from '@gf/contracts';
import { withTenant } from '@gf/db';
import { readBookingPolicy } from '@gf/scheduling';
import { dispatch } from '../bus';
import {
  loadDeskSettings, loadCheckoutSettings, load10DlcStatus, loadIntakeWaiver, loadWebhooks,
} from '../queries/settings';
import { loadSetupReadiness } from '../queries/setupReadiness';
import { loadNotificationSettings } from '../queries/notificationSettings';
import type { CtxFromHeaders } from './utils';

export function registerSettingsRoutes(app: FastifyInstance, ctxFromHeaders: CtxFromHeaders): void {

  app.get('/v1/desk/entitlements', async (req) => {
    const ctx = await ctxFromHeaders(req);
    return withTenant(ctx, async tx => {
      const [row] = await tx<{ plan: string }[]>`select plan from billing_accounts where location_id=${ctx.locationId}`;
      return { plan: row?.plan ?? 'essential' };
    });
  });

  const handleSetupReadiness = async (req: FastifyRequest) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('settings.manage')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'settings.manage' } });
    }
    return withTenant(ctx, (tx) => loadSetupReadiness(tx, ctx));
  };
  app.get('/v1/desk/setup/readiness', handleSetupReadiness);
  app.get('/api/desk/setup/readiness', handleSetupReadiness);

  app.get('/v1/desk/settings/booking-policy', async (req) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('settings.manage')) throw new AppError(ERROR_CODES.PERMISSION_DENIED);
    return withTenant(ctx, async (tx) => {
      const [row] = await tx<{ settings: unknown }[]>`select settings from locations where id = ${ctx.locationId}`;
      if (!row) throw new AppError(ERROR_CODES.NOT_FOUND);
      return readBookingPolicy(row.settings);
    });
  });

  // ── 系统设置与门店配置 ───────────────────────────────────────────────────
  const handleDeskSettings = async (req: FastifyRequest) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('settings.manage') && !ctx.permissions.has('staff.manage')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'settings.manage' } });
    }
    return withTenant(ctx, (tx) => loadDeskSettings(tx, ctx));
  };
  app.get('/v1/desk/settings', handleDeskSettings);
  app.get('/api/desk/settings', handleDeskSettings);

  /**
   * 外发通知的配置：12 个事件的规则、在用的模板、节日日程，以及**闸门状态**。
   *
   * ⚠️ 闸门状态是这一页最要紧的一半。只给开关不给闸门，店主打开之后唯一能
   * 得到的反馈是「什么也没发生」—— 而那不会报错（`queries/notificationSettings.ts`）。
   */
  const handleNotificationSettings = async (req: FastifyRequest) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('settings.manage')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'settings.manage' } });
    }
    return withTenant(ctx, (tx) => loadNotificationSettings(tx, ctx));
  };
  app.get('/v1/desk/settings/notifications', handleNotificationSettings);
  app.get('/api/desk/settings/notifications', handleNotificationSettings);

  const handleSaveLocation = async (req: FastifyRequest<{ Body: Record<string, unknown> }>) => {
    const ctx = await ctxFromHeaders(req);
    const res = await dispatch('location.saveProfile', req.body, ctx);
    return res.result;
  };
  app.patch<{ Body: Record<string, unknown> }>('/v1/desk/settings/location', handleSaveLocation);
  app.patch<{ Body: Record<string, unknown> }>('/api/desk/settings/location', handleSaveLocation);

  const handleSaveBusinessHours = async (req: FastifyRequest<{ Body: Record<string, unknown> }>) => {
    const ctx = await ctxFromHeaders(req);
    const res = await dispatch('location.saveHours', req.body, ctx);
    return res.result;
  };
  app.put<{ Body: Record<string, unknown> }>('/v1/desk/settings/business-hours', handleSaveBusinessHours);
  app.put<{ Body: Record<string, unknown> }>('/api/desk/settings/business-hours', handleSaveBusinessHours);

  const handleGetCheckout = async (req: FastifyRequest) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('settings.manage') && !ctx.permissions.has('ticket.read')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'settings.manage' } });
    }
    return withTenant(ctx, (tx) => loadCheckoutSettings(tx, ctx));
  };
  app.get('/v1/desk/settings/checkout', handleGetCheckout);
  app.get('/api/desk/settings/checkout', handleGetCheckout);

  const handleSaveCheckout = async (req: FastifyRequest<{ Body: Record<string, unknown> }>) => {
    const ctx = await ctxFromHeaders(req);
    const res = await dispatch('settings.saveCheckout', req.body, ctx);
    return res.result;
  };
  app.put<{ Body: Record<string, unknown> }>('/v1/desk/settings/checkout', handleSaveCheckout);
  app.put<{ Body: Record<string, unknown> }>('/api/desk/settings/checkout', handleSaveCheckout);

  const handleSaveOnlineBooking = async (req: FastifyRequest<{ Body: Record<string, unknown> }>) => {
    const ctx = await ctxFromHeaders(req);
    const res = await dispatch('location.saveOnlineBooking', req.body, ctx);
    return res.result;
  };
  app.put<{ Body: Record<string, unknown> }>('/v1/desk/settings/online-booking', handleSaveOnlineBooking);
  app.put<{ Body: Record<string, unknown> }>('/api/desk/settings/online-booking', handleSaveOnlineBooking);

  const handleSaveStaffProfile = async (req: FastifyRequest<{ Body: Record<string, unknown> }>) => {
    const ctx = await ctxFromHeaders(req);
    const res = await dispatch('staff.saveProfile', req.body, ctx);
    return res.result;
  };
  app.put<{ Body: Record<string, unknown> }>('/v1/desk/settings/staff/profile', handleSaveStaffProfile);
  app.put<{ Body: Record<string, unknown> }>('/api/desk/settings/staff/profile', handleSaveStaffProfile);

  const handleSaveStaffRotation = async (req: FastifyRequest<{ Body: Record<string, unknown> }>) => {
    const ctx = await ctxFromHeaders(req);
    const res = await dispatch('staff.setRotation', req.body, ctx);
    return res.result;
  };
  app.put<{ Body: Record<string, unknown> }>('/v1/desk/settings/staff/rotation', handleSaveStaffRotation);
  app.put<{ Body: Record<string, unknown> }>('/api/desk/settings/staff/rotation', handleSaveStaffRotation);

  const handleSavePhoneAssistant = async (req: FastifyRequest<{ Body: Record<string, unknown> }>) => {
    const ctx = await ctxFromHeaders(req);
    const res = await dispatch('settings.savePhoneAssistant', req.body, ctx);
    return res.result;
  };
  app.put<{ Body: Record<string, unknown> }>('/v1/desk/settings/phone-assistant', handleSavePhoneAssistant);
  app.put<{ Body: Record<string, unknown> }>('/api/desk/settings/phone-assistant', handleSavePhoneAssistant);

  const handleApply10Dlc = async (req: FastifyRequest<{ Body: Record<string, unknown> }>) => {
    const ctx = await ctxFromHeaders(req);
    const res = await dispatch('settings.apply10dlc', req.body, ctx);
    return res.result;
  };
  app.post<{ Body: Record<string, unknown> }>('/v1/desk/settings/10dlc/apply', handleApply10Dlc);
  app.post<{ Body: Record<string, unknown> }>('/api/desk/settings/10dlc/apply', handleApply10Dlc);

  const handleGet10DlcStatus = async (req: FastifyRequest) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('settings.manage') && !ctx.permissions.has('staff.manage')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'settings.manage' } });
    }
    return withTenant(ctx, (tx) => load10DlcStatus(tx, ctx));
  };
  app.get('/v1/desk/settings/10dlc/status', handleGet10DlcStatus);
  app.get('/api/desk/settings/10dlc/status', handleGet10DlcStatus);

  const handleSaveIntakeWaiver = async (req: FastifyRequest<{ Body: Record<string, unknown> }>) => {
    const ctx = await ctxFromHeaders(req);
    const res = await dispatch('settings.saveIntakeWaiver', req.body, ctx);
    return res.result;
  };
  app.put<{ Body: Record<string, unknown> }>('/v1/desk/settings/hardware/intake-waiver', handleSaveIntakeWaiver);
  app.put<{ Body: Record<string, unknown> }>('/api/desk/settings/hardware/intake-waiver', handleSaveIntakeWaiver);

  const handleGetIntakeWaiver = async (req: FastifyRequest) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('settings.manage') && !ctx.permissions.has('appointment.read')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'settings.manage' } });
    }
    return withTenant(ctx, (tx) => loadIntakeWaiver(tx, ctx));
  };
  app.get('/v1/desk/settings/hardware/intake-waiver', handleGetIntakeWaiver);
  app.get('/api/desk/settings/hardware/intake-waiver', handleGetIntakeWaiver);

  const handleSaveWebhooks = async (req: FastifyRequest<{ Body: Record<string, unknown> }>) => {
    const ctx = await ctxFromHeaders(req);
    const res = await dispatch('settings.saveWebhooks', req.body, ctx);
    return res.result;
  };
  app.put<{ Body: Record<string, unknown> }>('/v1/desk/settings/webhooks', handleSaveWebhooks);
  app.put<{ Body: Record<string, unknown> }>('/api/desk/settings/webhooks', handleSaveWebhooks);

  const handleGetWebhooks = async (req: FastifyRequest) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('settings.manage')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'settings.manage' } });
    }
    return withTenant(ctx, (tx) => loadWebhooks(tx, ctx));
  };
  app.get('/v1/desk/settings/webhooks', handleGetWebhooks);
  app.get('/api/desk/settings/webhooks', handleGetWebhooks);
}
