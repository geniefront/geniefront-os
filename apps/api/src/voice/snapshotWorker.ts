import type { FastifyInstance } from "fastify";
import type { CommandContext } from "@gf/contracts";
import { sql, withTenant } from "@gf/db";
import { refreshVoiceSnapshot } from "./snapshotRefresh";

export async function refreshVoiceSnapshots(
  app: Pick<FastifyInstance, "log">,
  progress: () => void = () => {},
  stopping: () => boolean = () => false,
) {
  const tenants = await sql<
    { org_id: string; location_id: string }[]
  >`select * from gf_private.voice_snapshot_tenants()`;
  progress();
  let refreshed = 0;
  // One calculation per worker; database leases coordinate multiple hosts.
  for (const t of tenants) {
    if (stopping()) break;
    const ctx: CommandContext = {
      orgId: t.org_id, locationId: t.location_id, membershipId: null,
      userId: null, actorKind: "api", timezone: "UTC", locale: "en",
      permissions: new Set(["appointment.write", "call.draft"]),
    };
    try {
      const [line] = await withTenant(ctx, tx => tx<{ tool_token_digest: string }[]>`
        select tool_token_digest from phone_lines where location_id=${ctx.locationId}
          and active and purpose='ai_voice' and ai_answer and assistant_id like 'agent_%'
          and tool_token_digest is not null limit 1`);
      if (!line) continue;
      const start = Date.now();
      if (await refreshVoiceSnapshot(ctx, line.tool_token_digest)) {
        refreshed++;
        app.log.info({ locationId: ctx.locationId, ms: Date.now() - start },
          "Voice seven-day snapshot refreshed");
      }
    } catch (error) {
      app.log.warn({ locationId: ctx.locationId,
        reason: error instanceof Error ? error.message : "refresh_failed" },
        "Voice snapshot refresh failed");
    } finally {
      progress();
    }
  }
  return refreshed;
}

/** Only called by snapshotMain, never by the HTTP API entrypoint. */
export function startVoiceSnapshots(app: FastifyInstance) {
  let active: Promise<unknown> | undefined;
  let stopping = false;
  let lastProgressAt = Date.now();
  let lastCompletedAt: number | null = null;
  let discoveryFailures = 0;
  const run = () => {
    if (active || stopping) return;
    active = refreshVoiceSnapshots(app, () => { lastProgressAt = Date.now(); }, () => stopping)
      .then(() => { lastCompletedAt = Date.now(); discoveryFailures = 0; })
      .catch(() => {
        discoveryFailures++;
        app.log.warn({ discoveryFailures }, "Voice snapshot discovery will retry");
      })
      .finally(() => { active = undefined; });
  };
  const timer = setInterval(run, 5000);
  timer.unref();
  app.addHook("onListen", async () => { run(); });
  app.addHook("onClose", async () => {
    stopping = true;
    clearInterval(timer);
    await active;
  });
  return () => ({
    ok: !stopping && Date.now() - lastProgressAt < 120_000 && discoveryFailures < 12,
    running: !!active, lastProgressAt, lastCompletedAt, discoveryFailures,
  });
}
