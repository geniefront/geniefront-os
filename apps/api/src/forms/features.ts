import type postgres from 'postgres';
import { healthFormTemplateKeyForBusinessType } from '@gf/contracts';

export interface HealthFormsFeatureState {
  enabled: boolean | null;
  effectiveEnabled: boolean;
  confirmedAt: string | null;
  templateKey: string;
  publishedTemplateId: string | null;
  publishedTemplateVersion: number | null;
}

export async function loadHealthFormsFeatureState(
  tx: postgres.TransactionSql,
  locationId: string,
): Promise<HealthFormsFeatureState> {
  const [location] = await tx<{
    business_type: string;
    enabled: boolean | null;
    confirmed_at: string | null;
  }[]>`
    select business_type,
      case when settings #> '{features}' ? 'health_forms_enabled'
        then (settings #>> '{features,health_forms_enabled}')::boolean else null end as enabled,
      nullif(settings #>> '{features,confirmed_at}', '') as confirmed_at
    from locations where id = ${locationId}`;
  const templateKey = healthFormTemplateKeyForBusinessType(location?.business_type ?? 'nail');
  const [published] = await tx<{ id: string; version: number }[]>`
    select id, version from form_templates
    where location_id = ${locationId} and key = ${templateKey}
      and active = true and published_at is not null
    order by version desc, created_at desc limit 1`;
  const [legacy] = location?.enabled === null
    ? await tx<{ present: boolean }[]>`
        select exists(select 1 from form_templates
          where location_id = ${locationId} and active = true
            and published_at is not null) as present`
    : [];
  return {
    enabled: location?.enabled ?? null,
    effectiveEnabled: location?.enabled ?? (legacy?.present ?? false),
    confirmedAt: location?.confirmed_at ?? null,
    templateKey,
    publishedTemplateId: published?.id ?? null,
    publishedTemplateVersion: published?.version ?? null,
  };
}
