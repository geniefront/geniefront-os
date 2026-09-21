import type { FastifyInstance } from "fastify";
import type { CommandContext } from "@gf/contracts";
import { sql, withTenant } from "@gf/db";
import { refreshVoiceSnapshot } from "./contextCache";

export async function refreshVoiceSnapshots(app: Pick<FastifyInstance, "log">) {
  const tenants = await sql<
    { org_id: string; location_id: string }[]
  >`select * from gf_private.voice_snapshot_tenants()`;
  let refreshed = 0;
  // Bounded concurrency leaves pool capacity for actual calls and booking writes.
  for (let i = 0; i < tenants.length; i += 2)
    await Promise.all(
      tenants.slice(i, i + 2).map(async (t) => {
        const ctx: CommandContext = {
          orgId: t.org_id,
          locationId: t.location_id,
          membershipId: null,
          userId: null,
          actorKind: "api",
          timezone: "UTC",
          locale: "en",
          permissions: new Set(["appointment.write", "call.draft"]),
        };
        try {
          const [line] = await withTenant(
            ctx,
            (tx) =>
              tx<
                { tool_token_digest: string }[]
              >`select tool_token_digest from phone_lines where location_id=${ctx.locationId} and active and purpose='ai_voice' and ai_answer and assistant_id like 'agent_%' and tool_token_digest is not null limit 1`,
          );
          if (!line) return;
          const start = Date.now();
          if (await refreshVoiceSnapshot(ctx, line.tool_token_digest)) {
            refreshed++;
            app.log.info(
              { locationId: ctx.locationId, ms: Date.now() - start },
              "Voice seven-day snapshot refreshed",
            );
          }
        } catch (error) {
          app.log.warn(
            {
              locationId: ctx.locationId,
              reason: error instanceof Error ? error.message : "refresh_failed",
            },
            "Voice snapshot refresh failed",
          );
        }
      }),
    );
  return refreshed;
}
export function startVoiceSnapshots(app: FastifyInstance) {
  let active: Promise<unknown> | undefined;
  const run = () => {
    if (active) return;
    active = refreshVoiceSnapshots(app)
      .catch(() => app.log.warn("Voice snapshot discovery will retry"))
      .finally(() => {
        active = undefined;
      });
  };
  const timer = setInterval(run, 5000);
  timer.unref();
  app.addHook("onListen", async () => run());
  app.addHook("onClose", async () => {
    clearInterval(timer);
    await active;
  });
}
