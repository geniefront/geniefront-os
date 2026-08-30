/**
 * Platform mutations write the same audit_log as customer commands.
 * actor_kind = 'platform' and actor_id = platform_operators.id so
 * support investigations still see the operator, not a shop membership.
 */

import type postgres from 'postgres';
import { jsonb } from '@gf/db';
import { redact } from '../audit';
import type { PlatformOperator } from './auth';

export async function writePlatformAudit(
  tx: postgres.TransactionSql,
  operator: PlatformOperator,
  args: {
    orgId: string;
    locationId: string;
    command: string;
    entityType?: string;
    entityId?: string;
    before?: unknown;
    after?: unknown;
    ip?: string;
  },
): Promise<string> {
  const after = args.after === undefined
    ? { operatorUserId: operator.userId, operatorRole: operator.role }
    : { ...redact(args.after, []), operatorUserId: operator.userId, operatorRole: operator.role };
  const before = args.before === undefined ? null : redact(args.before, []);

  const rows = await tx<{ id: string }[]>`
    insert into audit_log
      (org_id, location_id, actor_id, actor_device_id, actor_kind, command,
       entity_type, entity_id, before, after, ip)
    values
      (${args.orgId}, ${args.locationId}, ${operator.operatorId}, null, 'platform',
       ${args.command},
       ${args.entityType ?? null}, ${args.entityId ?? null},
       ${before === null ? null : jsonb(before)}::jsonb,
       ${jsonb(after)}::jsonb,
       ${args.ip ?? null})
    returning id`;
  return rows[0]!.id;
}
