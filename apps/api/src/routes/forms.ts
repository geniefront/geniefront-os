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
      customerId?: string;
      appointmentId?: string;
      answers: Record<string, unknown>;
      signerName?: string;
      signerRelation?: string;
      signatureUrl?: string;
    };
  }>('/v1/desk/forms/re-submit', async (req) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('appointment.write') && !ctx.permissions.has('customer.write')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'appointment.write' } });
    }
    const { templateId, customerId, appointmentId, answers, signerName, signerRelation, signatureUrl } = req.body;
    if (!templateId || !answers) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, { details: { reason: 'missing_template_or_answers' } });
    }

    // ⚠️ signatureUrl 校验：只允许 https: 和 data:（签名图片可以是 base64 内联）。
    if (signatureUrl) {
      let parsedUrl: URL;
      try { parsedUrl = new URL(signatureUrl); } catch {
        throw new AppError(ERROR_CODES.VALIDATION_FAILED, { details: { reason: 'signature_url_invalid' } });
      }
      if (!['https:', 'data:'].includes(parsedUrl.protocol)) {
        throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
          details: { reason: 'signature_url_protocol', allowed: ['https', 'data'] },
        });
      }
    }

    return withTenant(ctx, async (tx) => {
      const key = loadFormKey(process.env['FORM_ENCRYPTION_KEY']);
      const encrypted = encryptAnswers(answers, key);

      const [prev] = await tx<{ id: string; version: number }[]>`
        select id, version from form_submissions
        where location_id = ${ctx.locationId}
          and template_id = ${templateId}
          and (${customerId ?? null}::uuid is null or customer_id = ${customerId ?? null})
          and (${appointmentId ?? null}::uuid is null or appointment_id = ${appointmentId ?? null})
          and is_latest = true
        order by version desc limit 1`;

      const nextVersion = (prev?.version ?? 0) + 1;

      const [ins] = await tx<{ id: string }[]>`
        insert into form_submissions (
          org_id, location_id, customer_id, appointment_id, template_id, template_version,
          version, is_latest, answers_encrypted, enc_alg, signature_url, signed_at,
          signer_name, signer_relation, source, on_behalf_by
        ) values (
          ${ctx.orgId}, ${ctx.locationId}, ${customerId ?? null}, ${appointmentId ?? null},
          ${templateId}, 1, ${nextVersion}, true, ${encrypted}, 'aes-256-gcm.v1',
          ${signatureUrl ?? null}, now(), ${signerName ?? null}, ${signerRelation ?? 'self'},
          'desk', ${ctx.membershipId}
        ) returning id`;

      if (prev) {
        await tx`
          update form_submissions
          set is_latest = false, superseded_by = ${ins!.id}
          where id = ${prev.id}`;
      }

      return {
        submissionId: ins!.id,
        version: nextVersion,
        isLatest: true,
      };
    });
  });
}
