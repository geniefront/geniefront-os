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
  listDomains, verifyDomain, getDomain,
  domainLabelFromSlug, marketingDomainFor, marketingAddressFor, formatDnsInstructions,
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
 * `platform.setMarketingEmail` —— 运营在人工配完 Resend 与 DNS 之后，
 * 用这一条告诉后端「这家店可以发营销邮件了」。
 *
 * ## ⭐ 不接受运营手填地址，只接受「去问 Resend」
 *
 * 手填意味着一个笔误就把营销邮件指到一个不存在的地址上，而后果不是报错，
 * 是**整批退信** —— 退信率同样计入发信域名信誉，且当时没有任何人会察觉。
 * 因此启用只有一种走法：服务端调 Resend 的 domains 接口，确认该域名
 * `status = 'verified'`，通过了才写 `locations.marketing_email_from`。
 *
 * 也就是说这一条**核验的是事实，不是运营的声明**。运营点这个按钮表达的
 * 是「我配完了，你去查一下」，而不是「我保证配好了」。
 *
 * ## 权限
 *
 * 只有 `super_admin`。`support` 是给客服看数据的那一档，而这一条会改变
 * 一家店往外发商业邮件的能力。
 *
 * ⚠️ 本命令**不动 Resend 上的域名**：不建、不删、不改。建域名与加 DNS
 * 是人工步骤（`ops/marketingDomainCli.ts` 或 Resend 控制台）。
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
  const domain = marketingDomainFor(label);
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
   * ⚠️ 先问 Resend，再写库。顺序反过来的话，核验失败时那一列已经被写上，
   * 而它的语义是「已就绪」—— 营销邮件会在 DNS 还没生效时发出去。
   */
  const { data } = await listDomains();
  const found = data.find((d) => d.name === domain);
  if (!found) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: { reason: 'domain_not_in_resend', domain },
    });
  }

  await verifyDomain(found.id).catch(() => {
    /*
     * verify 本身失败不算致命：它只是让 Resend 立刻去查一次 DNS。
     * 下面那次 getDomain 拿到的状态才是判据。
     */
  });
  const fresh = await getDomain(found.id);

  if (fresh.status !== 'verified') {
    return {
      locationId: input.locationId,
      marketingEmailFrom: null,
      domain,
      domainStatus: fresh.status,
      dnsInstructions: formatDnsInstructions(fresh),
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
