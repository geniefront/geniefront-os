import { createHash } from 'node:crypto';
import {
  AppError, ERROR_CODES, platformSaveVoiceConfigurationSchema,
  readVoiceConfiguration, mergeVoiceConfiguration,
  type VoiceConfigurationPanel,
} from '@gf/contracts';
import { jsonb, withTenant } from '@gf/db';
import type { PlatformOperator } from './auth';
import { writePlatformAudit } from './audit';
import { oncePerPlatformIntent } from './idempotency';

type LocationVoiceRow = { settings: Record<string, unknown>; email: string | null; phone: string | null };
function panel(row: LocationVoiceRow): VoiceConfigurationPanel {
  const config = readVoiceConfiguration(row.settings, { email: row.email, phone: row.phone });
  return { ...config, revision: createHash('sha256').update(JSON.stringify(config)).digest('hex') };
}

export async function loadPlatformVoiceConfiguration(operator: PlatformOperator, orgId: string, locationId: string) {
  return withTenant({ orgId, locationId, membershipId: null, userId: operator.userId }, async tx => {
    const [row] = await tx<LocationVoiceRow[]>`select settings, email, phone from locations where id = ${locationId}`;
    if (!row) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'location' } });
    return panel(row);
  });
}

export async function savePlatformVoiceConfiguration(
  operator: PlatformOperator, orgId: string, locationId: string, raw: unknown, operationKey: string, ip?: string,
): Promise<VoiceConfigurationPanel> {
  const parsed = platformSaveVoiceConfigurationSchema.safeParse(raw);
  if (!parsed.success) throw new AppError(ERROR_CODES.VALIDATION_FAILED, { details: { issues: parsed.error.issues } });
  const input = parsed.data;
  return withTenant({ orgId, locationId, membershipId: null, userId: operator.userId }, tx =>
    oncePerPlatformIntent(tx, locationId, operator.operatorId, 'platform.saveVoiceConfiguration', operationKey, input, async () => {
      const [row] = await tx<LocationVoiceRow[]>`select settings, email, phone from locations where id = ${locationId} for update`;
      if (!row) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'location' } });
      const before = panel(row);
      if (before.revision !== input.expectedRevision) {
        throw new AppError(ERROR_CODES.VALIDATION_FAILED, { details: { reason: 'stale_voice_configuration' } });
      }
      const next = mergeVoiceConfiguration(row.settings, input);
      await tx`update locations set settings = ${jsonb(next)}::jsonb, updated_at = now() where id = ${locationId}`;
      const after = panel({ ...row, settings: next });
      await writePlatformAudit(tx, operator, {
        orgId, locationId, command: 'platform.saveVoiceConfiguration', entityType: 'location', entityId: locationId,
        before, after, ...(ip ? { ip } : {}),
      });
      return after;
    }),
  );
}
