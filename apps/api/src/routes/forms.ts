/**
 * 客户健康免责声明与表单路由
 *
 * 从 server.ts 拆出。包含：
 * - 表单列表查询 (/v1/desk/forms)
 * - 表单提交详情查询与访问日志留痕 (/v1/desk/forms/submissions/:id, /v1/desk/forms/submissions/:id/access)
 * - 预约表单历史 (/v1/desk/appointments/:id/forms)
 * - 表单重填与版本追加 (/v1/desk/forms/re-submit)
 */

import type { FastifyInstance } from 'fastify';
import {
  AppError, ERROR_CODES, type CommandContext,
} from '@gf/contracts';
import { withTenant } from '@gf/db';
import { dispatch } from '../bus';
import { loadForms, readSubmission, loadAppointmentForms } from '../queries/forms';
import { loadFormKey, encryptAnswers } from '../kiosk/crypto';
import type { CtxFromHeaders } from './utils';

/**
 * 为什么要看健康表 —— 白名单，前台在下拉框里选一个（`docs/15` §5）。
 *
 * ⚠️ 不接受自由文本：那样每条日志都会变成「查看」两个字，
 * 而这张表存在的意义就在于事后能回答「凭什么翻她的表」。
 */
export const FORM_ACCESS_REASONS = new Set([
  'service_prep',      // 马上要给他做，先看一眼禁忌 —— 九成是这条
  'incident_review',   // 出事了，回头查
  'customer_request',  // 客人自己要一份
  'export',            // 打印 / 导出 PDF
]);

export function registerFormsRoutes(app: FastifyInstance, ctxFromHeaders: CtxFromHeaders): void {

  // ── 查询：健康表（模板 / 已签 / 发出去的链接，docs/15 §5）───────────────
  app.get<{ Querystring: { days?: string; limit?: string; customerId?: string } }>(
    '/v1/desk/forms', async (req) => {
      const ctx = await ctxFromHeaders(req);
      if (!ctx.permissions.has('customer.read')) {
        throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'customer.read' } });
      }
      return withTenant(
        { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: ctx.membershipId },
        (tx) => loadForms(tx, ctx, {
          days: Number(req.query.days ?? '30') || 30,
          limit: Number(req.query.limit ?? '100') || 100,
          ...(req.query.customerId ? { customerId: req.query.customerId } : {}),
        }));
    });

  /**
   * ⭐ 打开一份已签的健康表。**这条路每走一次就留一条痕。**
   */
  const handleSubmissionAccess = async (
    ctx: CommandContext,
    submissionId: string,
    rawReason: string | undefined,
  ) => {
    const reason = rawReason ?? 'service_prep';
    if (!FORM_ACCESS_REASONS.has(reason)) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
        details: { reason: 'bad_access_reason', allowed: [...FORM_ACCESS_REASONS] },
      });
    }
    return withTenant(
      { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: ctx.membershipId },
      (tx) => readSubmission(tx, ctx, submissionId, reason));
  };

  app.get<{ Params: { id: string }; Querystring: { reason?: string } }>(
    '/v1/desk/forms/submissions/:id', async (req) => {
      const ctx = await ctxFromHeaders(req);
      return handleSubmissionAccess(ctx, req.params.id, req.query.reason);
    });

  app.post<{ Params: { id: string }; Body?: { reason?: string } }>(
    '/v1/desk/forms/submissions/:id/access', async (req) => {
      const ctx = await ctxFromHeaders(req);
      return handleSubmissionAccess(ctx, req.params.id, req.body?.reason);
    });

  // ── 预约健康表多版本历史 ───────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>('/v1/desk/appointments/:id/forms', async (req) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('appointment.read')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'appointment.read' } });
    }
    return withTenant(ctx, (tx) => loadAppointmentForms(tx, ctx, req.params.id));
  });

  // ── 健康免责声明重填与版本追加 ─────────────────────────────────────────────
  app.post<{
    Body: {
      templateId: string;
      customerId?: string | null;
      appointmentId?: string | null;
      answers: Record<string, unknown>;
      signerName?: string;
      signerRelation?: 'self' | 'guardian';
      signatureUrl?: string;
    };
  }>('/v1/desk/forms/re-submit', async (req) => {
    const ctx = await ctxFromHeaders(req);
    const b = req.body;
    if (!b?.templateId || !b.answers) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
        details: { reason: 'missing_template_or_answers' },
      });
    }

    /**
     * ⚠️ 这条路由以前自己写 `insert into form_submissions`（AUD-04）——
     * 一份**签过字的健康表**可以被前台改写，而 audit_log 里一条都没有。
     * 健康表恰恰是「谁在什么时候代客改了什么」必须查得到的那一类数据。
     *
     * 现在转给 `form.submit`（`supersedePrevious: true`）。
     * 顺带修掉两个原来自带的毛病：
     *   · 原来只加密答案，**签名图是明文入库的**；命令那一侧两样都加密
     *   · 原来写死 `template_version = 1`，和模板真实版本对不上
     */
    const out = await dispatch<{
      submissionId: string; expiresOn: string | null;
      version: number; supersededId: string | null;
    }>('form.submit', {
      templateId: b.templateId,
      customerId: b.customerId ?? null,
      appointmentId: b.appointmentId ?? null,
      answers: b.answers,
      ...(b.signatureUrl ? { signatureDataUrl: b.signatureUrl } : {}),
      signerName: b.signerName ?? '',
      signerRelation: b.signerRelation ?? 'self',
      locale: ctx.locale,
      source: 'desk',
      supersedePrevious: true,
    }, ctx);

    return {
      submissionId: out.result.submissionId,
      version: out.result.version,
      isLatest: true,
    };
  });
}
