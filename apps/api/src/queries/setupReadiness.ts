import type postgres from 'postgres';
import type { CommandContext, SetupReadiness, SetupMissingCode, SetupStepId } from '@gf/contracts';
import { AppError, ERROR_CODES } from '@gf/contracts';
import { ACTIVE_RESOURCE_STATUSES, ACTIVE_ROOM_TYPE_KEYS } from '../setupResources';
import { loadAiVoiceReadiness } from './aiVoiceReadiness';

const STEP_BY_MISSING: Record<SetupMissingCode, SetupStepId> = {
  profile: 'store',
  business_hours: 'store',
  active_room: 'rooms',
  active_service: 'catalog',
  bookable_staff: 'team',
};

interface ReadinessRow {
  voice_booking: boolean;
  id: string;
  status: string;
  profile_confirmed: boolean;
  hours_configured: boolean;
  active_rooms: number;
  active_services: number;
  bookable_staff: number;
  directory_entries: number;
  features_confirmed: boolean;
  features_confirmed_at: string | null;
  health_forms_enabled: boolean | null;
}

export async function loadSetupReadiness(
  tx: postgres.TransactionSql,
  ctx: Pick<CommandContext, 'locationId'>,
): Promise<SetupReadiness> {
  const [row] = await tx<ReadinessRow[]>`
    select l.id, l.status,
      exists (select 1 from billing_accounts b where b.location_id=l.id and b.plan='voice_booking') as voice_booking,
      (l.settings ? 'profile_confirmed_at') as profile_confirmed,
      exists (
        select 1 from jsonb_each(l.business_hours) h where h.value <> 'null'::jsonb
      ) as hours_configured,
      (select count(*)::int
       from resources r
       join resource_types rt on rt.id = r.resource_type_id
         and rt.location_id = r.location_id and rt.org_id = r.org_id
       where r.location_id = l.id and r.capacity > 0
         and rt.key = any(${[...ACTIVE_ROOM_TYPE_KEYS]})
         and r.status = any(${[...ACTIVE_RESOURCE_STATUSES]})) as active_rooms,
      (select count(*)::int from services s
       where s.location_id = l.id and s.active = true and s.is_addon = false) as active_services,
      (select count(*)::int from staff_profiles sp
       join memberships m on m.id = sp.membership_id
         and m.location_id = sp.location_id and m.org_id = sp.org_id
         and m.status = 'active'
       where sp.location_id = l.id and sp.is_bookable = true) as bookable_staff,
      ((select count(*) from staff_job_titles jt where jt.location_id = l.id)
       + (select count(*) from staff_levels sl where sl.location_id = l.id)
       + (select count(*) from skills sk where sk.location_id = l.id))::int as directory_entries,
      coalesce(l.settings #>> '{features,confirmed_at}', '') <> '' as features_confirmed,
      nullif(l.settings #>> '{features,confirmed_at}', '') as features_confirmed_at,
      case when l.settings #> '{features}' ? 'health_forms_enabled'
        then (l.settings #>> '{features,health_forms_enabled}')::boolean else null end as health_forms_enabled
    from locations l where l.id = ${ctx.locationId}`;
  if (!row) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'location' } });

  const aiVoice = await loadAiVoiceReadiness(tx, ctx);

  const missingCodes = [
    !row.profile_confirmed && 'profile',
    !row.hours_configured && 'business_hours',
    !row.voice_booking && row.active_rooms < 1 && 'active_room',
    row.active_services < 1 && 'active_service',
    row.bookable_staff < 1 && 'bookable_staff',
  ].filter((value): value is SetupMissingCode => Boolean(value));
  const launchMissing = row.status === 'setup' ? missingCodes : [];

  return {
    locationId: row.id,
    status: row.status,
    canLaunch: row.status !== 'setup' || launchMissing.length === 0,
    steps: [
      { id: 'store', complete: row.profile_confirmed && row.hours_configured },
      { id: 'directory', complete: row.directory_entries > 0 },
      { id: 'rooms', complete: row.voice_booking || row.active_rooms > 0 },
      { id: 'catalog', complete: row.active_services > 0 },
      { id: 'team', complete: row.bookable_staff > 0 },
      { id: 'features', complete: row.features_confirmed },
      { id: 'launch', complete: row.status === 'active' },
    ],
    missing: launchMissing.map((code) => ({ code, stepId: STEP_BY_MISSING[code] })),
    warnings: [
      ...(!row.voice_booking && row.directory_entries < 1
        ? [{ code: 'directory_recommended' as const, stepId: 'directory' as const }] : []),
      ...(!row.voice_booking && row.status !== 'setup' && row.active_rooms < 1
        ? [{ code: 'active_room_repair' as const, stepId: 'rooms' as const }] : []),
      // 店主想要 AI 电话但落地号 / 工具 token 还没就绪：提示，不阻塞开店。
      ...(aiVoice.intent === true && !aiVoice.ready
        ? [{ code: 'ai_voice_pending' as const, stepId: 'features' as const }] : []),
    ],
    aiVoice,
    features: {
      healthFormsEnabled: row.health_forms_enabled,
      confirmedAt: row.features_confirmed_at,
    },
  };
}
