/**
 * Named platform mutations. Not registered on the customer command bus.
 * Each one: operator already verified → withTenant(target) → write → audit.
 */

import { z } from 'zod';
import {
  AppError, ERROR_CODES,
  PlatformReview10DlcInput,
  PlatformUpdateSupportRequestInput,
  PlatformAddSupportNoteInput,
  PlatformUpdateStorefrontBriefInput,
  PlatformUpdateStorefrontRevisionInput,
  PlatformSetMarketingEmailInput,
} from '@gf/contracts';

function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: { issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })) },
    });
  }
  return parsed.data;
}
import { parseTs, withTenant } from '@gf/db';
import type { PlatformOperator } from './auth';
import { writePlatformAudit } from './audit';
import {
  marketingDomainStatus, marketingDomain,
  domainLabelFromSlug, marketingAddressFor, explainDomainProblem,
} from '../email/marketingDomain';

const TEN_DLC_STATUS: Record<
  'under_review' | 'request_changes' | 'reject' | 'approve_internal',
  'under_review' | 'rejected' | 'approved'
> = {
  under_review: 'under_review',
  request_changes: 'rejected',
  reject: 'rejected',
  approve_internal: 'approved',
};

export async function review10DlcForLocation(
  operator: PlatformOperator,
  orgId: string,
  raw: unknown,
  ip?: string,
): Promise<{ locationId: string; status: string; reviewKind: 'internal_geniefront' }> {
  const input = parse(PlatformReview10DlcInput, raw);
  if ((input.action === 'request_changes' || input.action === 'reject') && !input.notes?.trim()) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: { reason: 'notes_required', action: input.action },
    });
  }
  const next = TEN_DLC_STATUS[input.action];
  const notes = input.notes?.trim()
    ? `${input.action}: ${input.notes.trim()}`
    : `${input.action}: internal review`;

  return withTenant(
    { orgId, locationId: input.locationId, membershipId: null, userId: operator.userId },
    async (tx) => {
      const [row] = await tx<{ status: string }[]>`
        select status from location_10dlc_registrations
        where location_id = ${input.locationId}`;
      if (!row) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'location_10dlc' } });
      if (row.status === 'not_submitted') {
        throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
          details: { reason: 'not_submitted', status: row.status },
        });
      }

      await tx`
        update location_10dlc_registrations set
          status = ${next},
          notes = ${notes},
          reviewed_at = now(),
          updated_at = now()
        where location_id = ${input.locationId}`;

      await writePlatformAudit(tx, operator, {
        orgId,
        locationId: input.locationId,
        command: 'platform.review10Dlc',
        entityType: 'location_10dlc',
        entityId: input.locationId,
        before: { status: row.status },
        after: {
          status: next,
          action: input.action,
          reviewKind: 'internal_geniefront',
          carrierSubmitted: false,
        },
        ...(ip ? { ip } : {}),
      });

      return {
        locationId: input.locationId,
        status: next,
        reviewKind: 'internal_geniefront' as const,
      };
    },
  );
}

export async function updateSupportRequest(
  operator: PlatformOperator,
  orgId: string,
  locationId: string,
  raw: unknown,
  ip?: string,
): Promise<{ requestId: string; status: string }> {
  const input = parse(PlatformUpdateSupportRequestInput, raw);
  return withTenant(
    { orgId, locationId, membershipId: null, userId: operator.userId },
    async (tx) => {
      const [row] = await tx<{ status: string; priority: string }[]>`
        select status, priority from support_requests where id = ${input.requestId}`;
      if (!row) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'support_request' } });

      const nextStatus = input.status ?? row.status;
      const resolved = nextStatus === 'resolved' || nextStatus === 'closed';

      await tx`
        update support_requests set
          status = ${nextStatus},
          priority = ${input.priority ?? row.priority},
          assigned_operator_id = ${
            input.assignedOperatorId === undefined
              ? tx`assigned_operator_id`
              : input.assignedOperatorId
          },
          resolved_at = case
            when ${resolved} then coalesce(resolved_at, now())
            else null
          end,
          -- AUD-08：客户那边靠这一列显示「客服在处理」。
          -- 备注内容不给，只给「有人动过、什么时候」。
          last_operator_update_at = now(),
          updated_at = now()
        where id = ${input.requestId}`;

      await writePlatformAudit(tx, operator, {
        orgId, locationId,
        command: 'platform.updateSupportRequest',
        entityType: 'support_request',
        entityId: input.requestId,
        before: { status: row.status, priority: row.priority },
        after: { status: nextStatus, priority: input.priority ?? row.priority },
        ...(ip ? { ip } : {}),
      });

      return { requestId: input.requestId, status: nextStatus };
    },
  );
}

export async function addSupportNote(
  operator: PlatformOperator,
  orgId: string,
  locationId: string,
  raw: unknown,
  ip?: string,
): Promise<{ noteId: string; createdAt: string }> {
  const input = parse(PlatformAddSupportNoteInput, raw);
  return withTenant(
    { orgId, locationId, membershipId: null, userId: operator.userId },
    async (tx) => {
      const [exists] = await tx<{ id: string }[]>`
        select id from support_requests where id = ${input.requestId}`;
      if (!exists) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'support_request' } });

      if (input.publicReply) {
        const [message] = await tx<{ id: string; created_at: string | Date }[]>`insert into support_request_messages
          (org_id,location_id,request_id,author_kind,author_user_id,body)
          values (${orgId},${locationId},${input.requestId},'operator',${operator.userId},${input.body}) returning id,created_at`;
        await tx`update support_requests set status='waiting',last_operator_update_at=now(),updated_at=now() where id=${input.requestId}`;
        await writePlatformAudit(tx,operator,{orgId,locationId,command:'platform.replySupportRequest',entityType:'support_request',entityId:input.requestId,after:{messageId:message!.id}});
        return { noteId: message!.id, createdAt: parseTs(message!.created_at).toISOString() };
      }
      const [note] = await tx<{ id: string; created_at: string | Date }[]>`
        insert into support_request_notes
          (org_id, location_id, request_id, author_operator_id, body)
        values
          (${orgId}, ${locationId}, ${input.requestId}, ${operator.operatorId}, ${input.body})
        returning id, created_at`;

      // 加备注也算「客服动过了」（AUD-08）。内容仍然不外露。
      await tx`
        update support_requests
        set last_operator_update_at = now(), updated_at = now()
        where id = ${input.requestId}`;

      await writePlatformAudit(tx, operator, {
        orgId, locationId,
        command: 'platform.addSupportNote',
        entityType: 'support_request',
        entityId: input.requestId,
        after: { noteId: note!.id },
        ...(ip ? { ip } : {}),
      });

      return { noteId: note!.id, createdAt: parseTs(note!.created_at).toISOString() };
    },
  );
}

export async function updateStorefrontBrief(
  operator: PlatformOperator,
  orgId: string,
  locationId: string,
  raw: unknown,
  ip?: string,
): Promise<{ briefId: string; status: string }> {
  const input = parse(PlatformUpdateStorefrontBriefInput, raw);
  return withTenant(
    { orgId, locationId, membershipId: null, userId: operator.userId },
    async (tx) => {
      const [row] = await tx<{ id: string; status: string }[]>`
        select id, status from storefront_briefs where id = ${input.briefId}`;
      if (!row) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'storefront_brief' } });
      if (row.status !== 'submitted') {
        throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
          details: { reason: 'brief_not_submitted', status: row.status },
        });
      }
      await tx`
        update storefront_briefs
        set status = 'drafted', drafted_at = coalesce(drafted_at, now()), updated_at = now()
        where id = ${input.briefId}`;

      await writePlatformAudit(tx, operator, {
        orgId, locationId,
        command: 'platform.updateStorefrontWork',
        entityType: 'storefront_brief',
        entityId: input.briefId,
        before: { status: row.status },
        after: { status: 'drafted', action: input.action },
        ...(ip ? { ip } : {}),
      });
      return { briefId: input.briefId, status: 'drafted' };
    },
  );
}

export async function updateStorefrontRevision(
  operator: PlatformOperator,
  orgId: string,
  locationId: string,
  raw: unknown,
  ip?: string,
): Promise<{ revisionId: string; status: string }> {
  const input = parse(PlatformUpdateStorefrontRevisionInput, raw);
  return withTenant(
    { orgId, locationId, membershipId: null, userId: operator.userId },
    async (tx) => {
      const [row] = await tx<{ id: string; status: string }[]>`
        select id, status from storefront_revisions
        where id = ${input.revisionId} and location_id = ${locationId}`;
      if (!row) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'storefront_revision' } });

      await tx`
        update storefront_revisions set
          status = ${input.status},
          response = ${input.response ?? null},
          updated_at = now()
        where id = ${input.revisionId}`;

      await writePlatformAudit(tx, operator, {
        orgId, locationId,
        command: 'platform.updateStorefrontWork',
        entityType: 'storefront_revision',
        entityId: input.revisionId,
        before: { status: row.status },
        after: { status: input.status },
        ...(ip ? { ip } : {}),
      });
      return { revisionId: input.revisionId, status: input.status };
    },
  );
}


// ═══════════════════════════════════════════ 营销邮件的门店专属发件地址

/**
 * `platform.setMarketingEmail` —— 运营用这一条告诉后端「这家店可以发营销邮件了」。
 *
 * ## ⭐ 不接受运营手填地址，只接受「去问供应商」
 *
 * 手填意味着一个笔误就把营销邮件指向一个不存在的地址，而后果不是报错，
 * 是**整批退信** —— 退信率同样计入发信域名信誉，且当时不会有任何人察觉。
 * 因此启用只有一种路径：服务端向当前邮件供应商核实营销域
 * （`MARKETING_EMAIL_DOMAIN`，当前 `mkt.geniefront.com`）确为 `verified`，
 * 通过后才写 `locations.marketing_email_from`。
 *
 * 也就是说这一条**核验的是事实，而非运营的声明**。
 *
 * ⚠️ 核验的对象是**所有门店共用的那一个营销域**，不是这家店专属的东西
 * （2026-09-02 起营销域只有一个，门店身份体现在本地部分上）。因此它答的是
 * 「营销通道整体是否可用」—— 一家店验过之后下一家仍要再验一次，是有意的：
 * 域名可能在两次之间被供应商停用，而停用不会有任何通知。
 *
 * ## 权限
 *
 * 仅限 `super_admin`。`support` 是供客服查阅数据的档位，而本命令会改变
 * 一家门店对外发送商业邮件的能力。
 *
 * ⚠️ 本命令**不修改供应商侧的任何配置**：不创建、不删除、不变更域名。
 */
export async function setMarketingEmailForLocation(
  operator: PlatformOperator,
  orgId: string,
  slug: string,
  raw: unknown,
  ip?: string,
): Promise<{
  locationId: string;
  marketingEmailFrom: string | null;
  domain: string;
  domainStatus: string;
  dnsInstructions?: string;
}> {
  const input = parse(PlatformSetMarketingEmailInput, raw);

  if (operator.role !== 'super_admin') {
    throw new AppError(ERROR_CODES.PERMISSION_DENIED, {
      details: { reason: 'requires_super_admin', action: input.action },
    });
  }

  const label = input.label ?? domainLabelFromSlug(slug);
  if (!label) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: { reason: 'cannot_derive_label', slug },
    });
  }
  const domain = marketingDomain();
  const address = marketingAddressFor(label);
  const tenant = {
    orgId, locationId: input.locationId, membershipId: null, userId: operator.userId,
  };

  if (input.action === 'disable') {
    return withTenant(tenant, async (tx) => {
      const [before] = await tx<{ from_addr: string | null }[]>`
        select marketing_email_from as from_addr from locations
        where id = ${input.locationId}`;
      await tx`update locations set marketing_email_from = null
               where id = ${input.locationId}`;
      await writePlatformAudit(tx, operator, {
        orgId,
        locationId: input.locationId,
        command: 'platform.setMarketingEmail',
        entityType: 'location',
        entityId: input.locationId,
        before: { marketingEmailFrom: before?.from_addr ?? null },
        after: { marketingEmailFrom: null, action: 'disable' },
        ...(ip ? { ip } : {}),
      });
      return {
        locationId: input.locationId,
        marketingEmailFrom: null,
        domain,
        domainStatus: 'disabled',
      };
    });
  }

  /*
   * ⚠️ 先核验供应商，再写库。顺序颠倒的话，核验失败时该列已被写入，
   * 而它的语义是「已就绪」—— 营销邮件会从一个不可用的域发出去。
   */
  const fresh = await marketingDomainStatus();

  if (fresh.status !== 'verified') {
    return {
      locationId: input.locationId,
      marketingEmailFrom: null,
      domain,
      domainStatus: fresh.status,
      dnsInstructions: explainDomainProblem(fresh),
    };
  }

  return withTenant(tenant, async (tx) => {
    const [before] = await tx<{ from_addr: string | null }[]>`
      select marketing_email_from as from_addr from locations
      where id = ${input.locationId}`;
    await tx`update locations set marketing_email_from = ${address}
             where id = ${input.locationId}`;
    await writePlatformAudit(tx, operator, {
      orgId,
      locationId: input.locationId,
      command: 'platform.setMarketingEmail',
      entityType: 'location',
      entityId: input.locationId,
      before: { marketingEmailFrom: before?.from_addr ?? null },
      after: { marketingEmailFrom: address, action: 'check', domainStatus: fresh.status },
      ...(ip ? { ip } : {}),
    });
    return {
      locationId: input.locationId,
      marketingEmailFrom: address,
      domain,
      domainStatus: fresh.status,
    };
  });
}
