/**
 * 健康告知表与免责声明只读/辅助工具 (29 §6.2, docs/15)
 */
import { pickText, type CommandContext } from '@gf/contracts';
import { withTenant } from '@gf/db';
import { loadForms } from '../../queries/forms.js';
import { dispatch } from '../../bus.js';
import { ShareForm } from '@gf/contracts';

export async function getHealthFormStatus(
  ctx: CommandContext,
  input: Record<string, unknown>,
): Promise<unknown> {
  const customerId = input['customerId'] ? String(input['customerId']).trim() : undefined;
  const appointmentId = input['appointmentId'] ? String(input['appointmentId']).trim() : undefined;

  return withTenant(ctx, async (tx) => {
    // 1. 若给定了 appointmentId，先解析其 customerId
    let targetCustomerId = customerId;
    if (!targetCustomerId && appointmentId) {
      const [appt] = await tx<{ customer_id: string | null }[]>`
        select customer_id from appointments where id = ${appointmentId} and location_id = ${ctx.locationId}`;
      if (appt?.customer_id) {
        targetCustomerId = appt.customer_id;
      }
    }

    if (!targetCustomerId) {
      return {
        status: 'unknown',
        signed: false,
        note: '未指定明确的客户 ID，无法查询健康表状态',
      };
    }

    const { submissions, shares } = await loadForms(tx, ctx, {
      customerId: targetCustomerId,
      days: 365,
      limit: 10,
    });

    const activeSubmissions = submissions.filter((s) => !s.expired && !s.anonymized);
    if (activeSubmissions.length > 0) {
      const latest = activeSubmissions[0]!;
      return {
        status: 'signed',
        signed: true,
        lastSignedAt: latest.signedAt ?? latest.createdAt,
        templateTitle: pickText(latest.templateTitle, ctx.locale),
        expired: false,
        note: `已签署有效健康免责声明（${latest.signedAt?.slice(0, 10) ?? '近期'}），无需重复填写。`,
      };
    }

    const pendingShare = shares.find((s) => s.state === 'pending' || s.state === 'opened');
    if (pendingShare) {
      return {
        status: 'pending',
        signed: false,
        pendingShareId: pendingShare.shareId,
        expiresAt: pendingShare.expiresAt,
        note: '已生成填表邀请，顾客尚未提交完成。',
      };
    }

    return {
      status: 'none',
      signed: false,
      note: '该顾客尚未签署健康免责声明，建议在服务前安排填写。',
    };
  });
}

export async function getHealthFormLink(
  ctx: CommandContext,
  input: Record<string, unknown>,
): Promise<unknown> {
  const customerId = input['customerId'] ? String(input['customerId']).trim() : undefined;
  const appointmentId = input['appointmentId'] ? String(input['appointmentId']).trim() : undefined;
  const locale = (input['locale'] ? String(input['locale']) : ctx.locale ?? 'zh-Hans') as any;

  try {
    const { result } = await dispatch<typeof ShareForm.output._type>(
      'form.share',
      {
        customerId: customerId ?? null,
        appointmentId: appointmentId ?? null,
        channel: 'qr',
        locale,
        expiresInHours: 72,
      },
      ctx,
    );

    return {
      success: true,
      url: result.url,
      shareId: result.shareId,
      expiresAt: result.expiresAt,
      message: `健康免责表链接已生成：${result.url}`,
    };
  } catch (err: any) {
    return {
      success: false,
      error: err?.message || '生成健康表链接失败',
    };
  }
}
