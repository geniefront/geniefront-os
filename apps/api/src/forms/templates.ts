import type postgres from 'postgres';
import {
  INDUSTRY_HEALTH_FORM_PRESETS,
  SaveFormTemplate,
  healthFormTemplateKeyForBusinessType,
  type CommandContext,
} from '@gf/contracts';
import { jsonb } from '@gf/db';

type TemplateInput = typeof SaveFormTemplate.input._type;

export interface PublishedFormTemplate {
  templateId: string;
  version: number;
  created: boolean;
}

export async function lockFormTemplateKey(
  tx: postgres.TransactionSql,
  locationId: string,
  key: string,
): Promise<void> {
  await tx`select pg_advisory_xact_lock(hashtext(${`form-template:${locationId}:${key}`}))`;
}

/** Shared publishing primitive. The caller owns audit, permission, and input validation. */
export async function publishFormTemplate(
  tx: postgres.TransactionSql,
  ctx: Pick<CommandContext, 'orgId' | 'locationId'>,
  input: TemplateInput,
): Promise<PublishedFormTemplate> {
  await lockFormTemplateKey(tx, ctx.locationId, input.key);
  const [prev] = await tx<{ v: number | null }[]>`
    select max(version)::int as v from form_templates
    where location_id = ${ctx.locationId} and key = ${input.key}`;
  const version = (prev?.v ?? 0) + 1;

  await tx`update form_templates set active = false
    where location_id = ${ctx.locationId} and key = ${input.key}`;
  const [row] = await tx<{ id: string }[]>`
    insert into form_templates
      (org_id, location_id, key, version, title, schema,
       requires_signature, valid_days, service_ids, published_at, active)
    values (${ctx.orgId}, ${ctx.locationId}, ${input.key}, ${version},
            ${jsonb(input.title)}::jsonb, ${jsonb(input.questions)}::jsonb,
            ${input.requiresSignature}, ${input.validDays},
            ${jsonb(input.serviceIds)}::jsonb, now(), true)
    returning id`;
  return { templateId: row!.id, version, created: true };
}

/** Reuse a customized publication; create the shared industry preset only when none exists. */
export async function ensureIndustryHealthFormPublished(
  tx: postgres.TransactionSql,
  ctx: Pick<CommandContext, 'orgId' | 'locationId'>,
  businessType: string,
): Promise<PublishedFormTemplate> {
  const key = healthFormTemplateKeyForBusinessType(businessType);
  await lockFormTemplateKey(tx, ctx.locationId, key);
  const [existing] = await tx<{ id: string; version: number }[]>`
    select id, version from form_templates
    where location_id = ${ctx.locationId} and key = ${key}
      and published_at is not null
    order by version desc, created_at desc limit 1`;
  if (existing) {
    await tx`update form_templates set active = (id = ${existing.id})
      where location_id = ${ctx.locationId} and key = ${key}`;
    return { templateId: existing.id, version: existing.version, created: false };
  }

  const preset = INDUSTRY_HEALTH_FORM_PRESETS.find((item) => item.template.key === key);
  if (!preset) throw new Error(`Missing shared health-form preset for ${key}`);

  // The key lock is re-entrant inside this transaction.
  return publishFormTemplate(tx, ctx, SaveFormTemplate.input.parse(preset.template));
}
