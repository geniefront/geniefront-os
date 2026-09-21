import { randomBytes, createHash } from "node:crypto";
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

/** Store-only initial context, reused for at most 30 seconds. The colon-prefixed key
 * cannot be accepted as a booking reference by the public tool schema. */
export async function readInitialSnapshot(
  tx: postgres.TransactionSql,
  ctx: CommandContext,
  id: string,
  scope: string,
): Promise<unknown | undefined> {
  const [row] = await tx<
    { payload: unknown }[]
  >`select payload from voice_context_references where id=${id}
    and location_id=${ctx.locationId} and kind='offers' and scope=${scope} and expires_at>now()`;
  return row?.payload;
}
export async function saveInitialSnapshot(
  tx: postgres.TransactionSql,
  ctx: CommandContext,
  id: string,
  scope: string,
  payload: unknown,
) {
  await tx`delete from voice_context_references where id=${id} and location_id=${ctx.locationId} and expires_at<now()`;
  await tx`insert into voice_context_references(id,org_id,location_id,kind,scope,payload,expires_at)
    values(${id},${ctx.orgId},${ctx.locationId},'offers',${scope},${JSON.stringify(payload)}::jsonb,now()+interval '30 seconds') on conflict(id) do nothing`;
}
