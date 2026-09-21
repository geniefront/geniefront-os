import Fastify from "fastify";
import { beforeAll, afterAll, it, expect } from "vitest";
import { withTenant, closeDb, jsonb } from "@gf/db";
import { AppError } from "@gf/contracts";
import { buildContext } from "./actor";
import { registerScheduleRoutes } from "./routes/schedule";
import { buildServer } from "./server";
const tenant = {
  orgId: "11111111-1111-4111-8111-111111111111",
  locationId: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
  membershipId: null,
};
let ctx: Awaited<ReturnType<typeof buildContext>>, id: string, code: string;
const app = Fastify();
beforeAll(async () => {
  const [m] = await withTenant(
    tenant,
    (tx) =>
      tx`select m.id,m.user_id from memberships m join membership_roles mr on mr.membership_id=m.id join roles r on r.id=mr.role_id where m.location_id=${tenant.locationId} and r.key in ('owner','manager') limit 1`,
  );
  ctx = await buildContext({ userId: m!.user_id, membershipId: m!.id });
  const [a] = await withTenant(
    tenant,
    (tx) =>
      tx`insert into appointments(org_id,location_id,business_date,starts_at,ends_at,source,provider_call_id) values(${tenant.orgId},${tenant.locationId},current_date,now(),now()+interval '1 hour','phone_ai','access-test-call') returning id,staff_link_code`,
  );
  id = a!.id;
  code = a!.staff_link_code;
  await withTenant(
    tenant,
    (tx) =>
      tx`insert into phone_calls(org_id,location_id,provider_call_id,transcript,summary,recording_url) values(${tenant.orgId},${tenant.locationId},'access-test-call',${jsonb([{ role: "user", text: "Book a massage" }])}::jsonb,'Booked massage','https://recording.example/private')`,
  );
  registerScheduleRoutes(app, async () => ctx);
  app.setErrorHandler((err, _req, reply) => {
    const code = err instanceof AppError ? err.code : "INTERNAL";
    reply
      .status(
        code === "NOT_FOUND" ? 404 : code === "PERMISSION_DENIED" ? 403 : 500,
      )
      .send({ code });
  });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await closeDb();
});
it("requires authentication for short links, call details and recordings", async () => {
  const real = buildServer();
  await real.ready();
  try {
    for (const url of [
      `/v1/desk/booking-links/${code}`,
      `/v1/desk/appointments/${id}/call`,
      `/v1/desk/calls/${id}/recording`,
    ])
      expect((await real.inject({ url })).statusCode).toBe(401);
  } finally {
    await real.close();
  }
});
it("resolves only inside the authorized tenant and omits raw audio URLs", async () => {
  const link = await app.inject({ url: `/v1/desk/booking-links/${code}` });
  expect(link.statusCode).toBe(200);
  expect(link.json()).toEqual({
    appointmentId: id,
    locationId: tenant.locationId,
  });
  const call = await app.inject({ url: `/v1/desk/appointments/${id}/call` });
  expect(call.statusCode).toBe(200);
  expect(call.json().call.transcript[0].text).toBe("Book a massage");
  expect(call.json().call.hasRecording).toBe(true);
  expect(call.body).not.toContain("https://recording");
  expect(call.headers["cache-control"]).toBe("private, no-store");
  const saved = ctx;
  ctx = {
    ...ctx,
    orgId: "22222222-2222-4222-8222-222222222222",
    locationId: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb",
  };
  try {
    for (const url of [
      `/v1/desk/booking-links/${code}`,
      `/v1/desk/appointments/${id}/call`,
    ])
      expect((await app.inject({ url })).statusCode).toBe(404);
  } finally {
    ctx = saved;
  }
});
it("requires appointment read permission even with a known short code", async () => {
  const saved = ctx;
  ctx = { ...ctx, permissions: new Set() };
  try {
    expect(
      (await app.inject({ url: `/v1/desk/booking-links/${code}` })).statusCode,
    ).toBe(403);
  } finally {
    ctx = saved;
  }
});
it('returns multiple linked calls for a web booking and redacts conversation without contact permission',async()=>{
 await withTenant(tenant,async tx=>{
   await tx`update appointments set source='web' where id=${id}`;
   const [p]=await tx`insert into phone_calls(org_id,location_id,provider_call_id,started_at,duration_seconds,recording_id,transcript,voice_billing_status)
    values(${tenant.orgId},${tenant.locationId},'later-change',now(),90,'saved-before-transcription','[]','pending') returning id`;
   await tx`insert into voice_appointment_activity(org_id,location_id,appointment_id,caller,call_started_at,action,outcome,call_id)
    values(${tenant.orgId},${tenant.locationId},${id},'+12025550123',now(),'reschedule','completed',${p!.id})`;
 });
 const result=(await app.inject({url:`/v1/desk/appointments/${id}/call`})).json();
 expect(result.calls).toHaveLength(2);
 expect(result.calls[0].actions).toEqual([{action:'reschedule',outcome:'completed'}]);
 expect(result.calls[0].hasRecording).toBe(true);
 const saved=ctx;
 ctx={...ctx,permissions:new Set(['appointment.read'])};
 try{
  const restricted=(await app.inject({url:`/v1/desk/appointments/${id}/call`})).json();
  expect(restricted.calls.every((c:any)=>!c.hasRecording&&!c.summary&&c.transcript.length===0)).toBe(true);
 }finally{ctx=saved}
 const foreign={...tenant,orgId:'22222222-2222-4222-8222-222222222222',locationId:'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'};
 expect(await withTenant(foreign,tx=>tx`select id from voice_appointment_activity where appointment_id=${id}`)).toHaveLength(0);
});
it('does not guess a call association when two recordings overlap for the same caller',async()=>{
 const {linkVoiceActivities}=await import('./handlers/voiceActivity');
 await withTenant(tenant,async tx=>{
  for(const key of ['ambiguous-a','ambiguous-b']) await tx`insert into phone_calls(org_id,location_id,provider_call_id,from_e164,started_at,duration_seconds)
   values(${tenant.orgId},${tenant.locationId},${key},'+12025550999',now()-interval '5 seconds',60)`;
  await tx`insert into voice_appointment_activity(org_id,location_id,appointment_id,caller,call_started_at,action,outcome)
   values(${tenant.orgId},${tenant.locationId},${id},'+12025550999',now(),'lookup','requested')`;
  await linkVoiceActivities(tx,ctx);
  const [row]=await tx`select call_id from voice_appointment_activity where caller='+12025550999'`;
  expect(row?.call_id).toBeNull();
 });
});
