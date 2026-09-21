import type postgres from "postgres";
import {
  AppError,
  ERROR_CODES,
  RecordVoiceAppointmentActivity,
  type CommandContext,
} from "@gf/contracts";
import { registerHandler } from "../bus";

/** Match only verified caller metadata inside a unique recorded call window.
 * xAI starts after the Telnyx leg; overlapping calls remain unlinked. */
export async function linkVoiceActivities(
  tx: postgres.TransactionSql,
  ctx: CommandContext,
) {
  await tx`update voice_appointment_activity v set call_id=(
   select p.id from phone_calls p where p.location_id=v.location_id and p.from_e164=v.caller
    and v.call_started_at>=p.started_at-interval '10 seconds'
    and v.call_started_at<=p.started_at+make_interval(secs=>coalesce(p.duration_seconds,0))
    and v.call_started_at<=p.started_at+interval '60 seconds'
    and v.occurred_at>=p.started_at-interval '10 seconds'
    and v.occurred_at<=p.started_at+make_interval(secs=>coalesce(p.duration_seconds,0))+interval '30 seconds'
   limit 1)
 where v.location_id=${ctx.locationId} and v.call_id is null and (
   select count(*) from phone_calls p where p.location_id=v.location_id and p.from_e164=v.caller
    and v.call_started_at>=p.started_at-interval '10 seconds'
    and v.call_started_at<=p.started_at+make_interval(secs=>coalesce(p.duration_seconds,0))
    and v.call_started_at<=p.started_at+interval '60 seconds'
    and v.occurred_at>=p.started_at-interval '10 seconds'
    and v.occurred_at<=p.started_at+make_interval(secs=>coalesce(p.duration_seconds,0))+interval '30 seconds'
 )=1`;
}
export async function recordVoiceActivity(
  tx: postgres.TransactionSql,
  ctx: CommandContext,
  appointmentId: string,
  action: "lookup" | "reschedule" | "cancel",
  outcome: "requested" | "completed",
) {
  if (!ctx.voiceCall) return;
  await tx`insert into voice_appointment_activity(org_id,location_id,appointment_id,caller,call_started_at,action,outcome)
 values(${ctx.orgId},${ctx.locationId},${appointmentId},${ctx.voiceCall.caller},${ctx.voiceCall.startedAt},${action},${outcome})
 on conflict(location_id,appointment_id,caller,call_started_at,action) do update
 set outcome=case when voice_appointment_activity.outcome='completed' then 'completed' else excluded.outcome end`;
  await linkVoiceActivities(tx, ctx);
}
registerHandler(
  RecordVoiceAppointmentActivity,
  async ({ input, tx, ctx, audit }) => {
    if (!ctx.voiceCall) throw new AppError(ERROR_CODES.PERMISSION_DENIED);
    const [owned] =
      await tx`select a.id from appointments a join customers c on c.id=a.customer_id
 where a.id=${input.appointmentId} and a.location_id=${ctx.locationId} and c.phone_e164=${ctx.voiceCall.caller}`;
    if (!owned) throw new AppError(ERROR_CODES.NOT_FOUND);
    await recordVoiceActivity(
      tx,
      ctx,
      input.appointmentId,
      input.action,
      "requested",
    );
    audit({
      entityType: "appointment",
      entityId: input.appointmentId,
      after: { voiceAction: input.action },
    });
    return { saved: true };
  },
);
