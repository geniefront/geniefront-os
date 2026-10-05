// Only the dedicated snapshot worker may execute the seven-day calculation.
import type { CommandContext } from "@gf/contracts";
import { withTenant } from "@gf/db";
import { loadVoiceOffers } from "./offers";
import { claimInitialSnapshot, publishInitialSnapshot, failInitialSnapshot, referenceScope } from "./references";

const inFlight = new Map<string, Promise<boolean>>();
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
