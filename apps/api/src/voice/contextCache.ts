import { AppError, ERROR_CODES, type CommandContext } from "@gf/contracts";
import { withTenant } from "@gf/db";
import { businessDateOf } from "@gf/scheduling";
import { loadVoiceOffers } from "./offers";
import {
  readInitialSnapshot,
  claimInitialSnapshot,
  publishInitialSnapshot,
  failInitialSnapshot,
  referenceScope,
  type InitialSnapshotRecord,
} from "./references";

type Snapshot = Awaited<ReturnType<typeof loadVoiceOffers>>;
const inFlight = new Map<string, Promise<boolean>>();
export function usableSnapshot(
  row: InitialSnapshotRecord | undefined,
  scope: string,
  now = Date.now(),
): row is InitialSnapshotRecord & { payload: Snapshot } {
  if (
    !row?.generatedAt ||
    !row.payload ||
    row.scope !== scope ||
    now - Date.parse(row.generatedAt) > 300000
  )
    return false;
  const value = row.payload as Snapshot;
  if (!("shop" in value) || !value.shop || !value.coverage) return false;
  return (
    value.coverage.from ===
      businessDateOf(new Date(now), value.shop.timezone, "00:00") &&
    now - Date.parse(value.coverage.generatedAt) < 300000
  );
}
/** A lease is persisted before calculation; only its owner may publish.
 * Writes during calculation bump revision and leave the resulting snapshot dirty. */
export function refreshVoiceSnapshot(
  ctx: CommandContext,
  secret: string,
  force = false,
): Promise<boolean> {
  const scope = referenceScope(secret),
    key = `${ctx.locationId}:${scope}`;
  const pending = inFlight.get(key);
  if (pending) return pending;
  const work = (async () => {
    const lease = await withTenant(ctx, (tx) =>
      claimInitialSnapshot(tx, ctx, scope, force),
    );
    if (!lease) return false;
    try {
      const data = await loadVoiceOffers(ctx, secret);
      return await withTenant(ctx, (tx) =>
        publishInitialSnapshot(tx, ctx, scope, lease, data),
      );
    } catch (error) {
      await withTenant(ctx, (tx) =>
        failInitialSnapshot(tx, ctx, lease.leaseId),
      );
      throw error;
    }
  })();
  inFlight.set(key, work);
  void work
    .finally(() => {
      if (inFlight.get(key) === work) inFlight.delete(key);
    })
    .catch(() => {});
  return work;
}
function response(row: InitialSnapshotRecord & { payload: Snapshot }) {
  const data = structuredClone(row.payload),
    now = Date.now();
  const stale = !row.clean || now >= Date.parse(row.refreshAfter);
  data.coverage = {
    ...data.coverage,
    expiresInSeconds: Math.max(
      0,
      900 - Math.ceil((now - Date.parse(data.coverage.generatedAt)) / 1000),
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
  // Cold-start recovery is bounded and uses the same cross-node lease as the worker.
  await refreshVoiceSnapshot(ctx, secret, true);
  for (let attempt = 0; attempt < 12; attempt++) {
    const ready = await withTenant(ctx, (tx) => readInitialSnapshot(tx, ctx));
    if (usableSnapshot(ready, scope)) return response(ready);
    if (!ready?.leaseUntil || Date.parse(ready.leaseUntil) < Date.now()) break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE, {
    details: { reason: "context_refreshing", retryable: true },
  });
}
