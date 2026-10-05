import { randomBytes, createHash, randomUUID } from "node:crypto";
import type postgres from "postgres";
import { AppError, ERROR_CODES, type CommandContext } from "@gf/contracts";

export const referenceScope = (secret: string) =>
  createHash("sha256").update(secret).digest("hex");
export async function saveReference(
  tx: postgres.TransactionSql,
  ctx: CommandContext,
  kind: "offers" | "management",
  scope: string,
  payload: unknown,
) {
  const id = randomBytes(12).toString("base64url");
  await tx`delete from voice_context_references where location_id=${ctx.locationId} and expires_at<now()`;
  await tx`insert into voice_context_references(id,org_id,location_id,kind,scope,payload)
    values (${id},${ctx.orgId},${ctx.locationId},${kind},${scope},${JSON.stringify(payload)}::jsonb)`;
  return id;
}
export async function readReference(
  tx: postgres.TransactionSql,
  ctx: CommandContext,
  id: string,
  kind: "offers" | "management",
  scope: string,
): Promise<unknown> {
  const [row] = await tx<
    { payload: unknown }[]
  >`select payload from voice_context_references
    where id=${id} and location_id=${ctx.locationId} and kind=${kind} and scope=${scope} and expires_at>now()`;
  if (!row)
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: { reason: "selection_expired_query_again" },
    });
  return row.payload;
}

export interface InitialSnapshotRecord {
  scope: string;
  payload: unknown;
  generatedAt: string | null;
  refreshAfter: string;
  clean: boolean;
  revision: string;
  leaseUntil: string | null;
  retryAfter: string;
}
export async function readInitialSnapshot(
  tx: postgres.TransactionSql,
  ctx: CommandContext,
): Promise<InitialSnapshotRecord | undefined> {
  const [row] = await tx<
    InitialSnapshotRecord[]
  >`select scope,payload,generated_at::text as "generatedAt",refresh_after::text as "refreshAfter",
    revision=built_revision as clean,revision::text,lease_until::text as "leaseUntil",retry_after::text as "retryAfter"
    from voice_availability_snapshots where location_id=${ctx.locationId}`;
  return row;
}

/** Enqueue only. Preserve the current payload, revision, lease and backoff.
 * The existing worker discovery query already finds due/missing snapshots. */
export async function requestInitialSnapshot(
  tx: postgres.TransactionSql,
  ctx: CommandContext,
  scope: string,
  force = false,
): Promise<void> {
  await tx`insert into voice_availability_snapshots(location_id,org_id) values(${ctx.locationId},${ctx.orgId})
    on conflict (location_id) do update set refresh_after=least(voice_availability_snapshots.refresh_after,now())
    where voice_availability_snapshots.location_id=${ctx.locationId}
      and (${force} or voice_availability_snapshots.scope<>${scope} or voice_availability_snapshots.payload is null)
      and voice_availability_snapshots.refresh_after>now()`;
}
export async function claimInitialSnapshot(
  tx: postgres.TransactionSql,
  ctx: CommandContext,
  scope: string,
  force = false,
) {
  await tx`insert into voice_availability_snapshots(location_id,org_id) values(${ctx.locationId},${ctx.orgId}) on conflict(location_id) do nothing`;
  const leaseId = randomUUID();
  const [row] = await tx<
    { revision: string }[]
  >`update voice_availability_snapshots set lease_id=${leaseId},lease_until=now()+interval '60 seconds'
    where location_id=${ctx.locationId} and (lease_until is null or lease_until<now()) and retry_after<=now()
      and (${force} or refresh_after<=now() or scope<>${scope} or payload is null)
    returning revision::text`;
  return row ? { leaseId, revision: row.revision } : null;
}
export async function publishInitialSnapshot(
  tx: postgres.TransactionSql,
  ctx: CommandContext,
  scope: string,
  lease: { leaseId: string; revision: string },
  payload: unknown,
) {
  const rows =
    await tx`update voice_availability_snapshots set scope=${scope},payload=${JSON.stringify(payload)}::jsonb,
    generated_at=now(),built_revision=${lease.revision}::bigint,
    refresh_after=now()+case when revision=${lease.revision}::bigint then interval '60 seconds' else interval '2 seconds' end,
    retry_after=now(),lease_id=null,lease_until=null,last_error=null
    where location_id=${ctx.locationId} and lease_id=${lease.leaseId} and lease_until>now() returning location_id`;
  return rows.length === 1;
}
export async function failInitialSnapshot(
  tx: postgres.TransactionSql,
  ctx: CommandContext,
  leaseId: string,
) {
  await tx`update voice_availability_snapshots set lease_id=null,lease_until=null,retry_after=now()+interval '30 seconds',last_error='refresh_failed'
    where location_id=${ctx.locationId} and lease_id=${leaseId}`;
}
