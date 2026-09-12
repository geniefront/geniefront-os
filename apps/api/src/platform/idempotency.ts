import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import { jsonb } from '@gf/db';
import { AppError, ERROR_CODES } from '@gf/contracts';

export function platformOperationKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9:_-]{1,120}$/.test(value)) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, { details: { reason: 'invalid_idempotency_key' } });
  }
  return value;
}

/** The lock, effects, audit and saved response all share the caller's transaction. */
export async function oncePerPlatformIntent<T>(
  tx: postgres.TransactionSql, locationId: string, operatorId: string,
  command: string, operationKey: string, input: unknown, execute: () => Promise<T>,
): Promise<T> {
  const key = `platform:${operatorId}:${operationKey}`;
  const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  await tx`select pg_advisory_xact_lock(hashtext(${locationId}), hashtext(${key}))`;
  const [hit] = await tx<{ command: string; result_json: { fingerprint: string; result: T } }[]>`
    select command, result_json from command_idempotency where location_id = ${locationId} and key = ${key}`;
  if (hit) {
    if (hit.command !== command || hit.result_json.fingerprint !== fingerprint) {
      throw new AppError(ERROR_CODES.IDEMPOTENCY_KEY_REUSED);
    }
    return hit.result_json.result;
  }
  const result = await execute();
  await tx`insert into command_idempotency (location_id, key, command, result_json)
    values (${locationId}, ${key}, ${command}, ${jsonb({ fingerprint, result })}::jsonb)`;
  return result;
}
