import { AppError, ERROR_CODES, type CommandContext } from "@gf/contracts";
import { withTenant } from "@gf/db";
import { businessDateOf } from "@gf/scheduling";
import type { loadVoiceOffers } from "./offers";
import {
  readInitialSnapshot,
  requestInitialSnapshot,
  referenceScope,
  type InitialSnapshotRecord,
} from "./references";

type Snapshot = Awaited<ReturnType<typeof loadVoiceOffers>>;
export function usableSnapshot(
  row: InitialSnapshotRecord | undefined,
  scope: string,
  now = Date.now(),
): row is InitialSnapshotRecord & { payload: Snapshot } {
  if (
    !row?.generatedAt ||
    !row.payload || typeof row.payload !== 'object' ||
    row.scope !== scope ||
    !Number.isFinite(Date.parse(row.generatedAt)) ||
    now - Date.parse(row.generatedAt) < 0 ||
    now - Date.parse(row.generatedAt) >= 300000
  )
    return false;
  const value = row.payload as Snapshot;
  if (!("shop" in value) || !value.shop || !value.coverage) return false;
  return (
    value.coverage.from ===
      businessDateOf(new Date(now), value.shop.timezone, "00:00") &&
    now - Date.parse(value.coverage.generatedAt) >= 0 &&
    now - Date.parse(value.coverage.generatedAt) < 300000
  );
}
function response(row: InitialSnapshotRecord & { payload: Snapshot }) {
  const data = structuredClone(row.payload),
    now = Date.now();
  const stale = !row.clean || now >= Date.parse(row.refreshAfter);
  data.coverage = {
    ...data.coverage,
    expiresInSeconds: Math.max(
      0,
      300 - Math.ceil((now - Date.parse(data.coverage.generatedAt)) / 1000),
    ),
    ...{
      stale,
      ageSeconds: Math.max(
        0,
        Math.floor((now - Date.parse(row.generatedAt!)) / 1000),
      ),
      refreshing: !!row.leaseUntil && Date.parse(row.leaseUntil) > now,
    },
  };
  if ("shop" in data && data.shop)
    data.shop.currentTime = new Date(now).toISOString();
  return data;
}
export async function initialVoiceContext(ctx: CommandContext, secret: string) {
  const scope = referenceScope(secret);
  const row = await withTenant(ctx, (tx) => readInitialSnapshot(tx, ctx));
  if (usableSnapshot(row, scope)) return response(row);
  // Never recover a cold cache by running the seven-day calculation here.
  // A queued refresh survives API restarts and is claimed by the worker.
  await withTenant(ctx, (tx) => requestInitialSnapshot(tx, ctx, scope, true));
  throw new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE, {
    details: { reason: "context_refreshing", retryable: true, retryAfterSeconds: 5 },
  });
}

/** Prewarm requests only schedule work; they never run CPU work in the API. */
export async function requestVoiceSnapshot(ctx: CommandContext, secret: string): Promise<void> {
  await withTenant(ctx, (tx) => requestInitialSnapshot(tx, ctx, referenceScope(secret)));
}
