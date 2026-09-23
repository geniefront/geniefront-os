import { __resetAiRateLimit } from "./billing/aiAdmission";
import { __resetRateLimit } from "./public/rateLimit";
import { beforeAll, afterAll, beforeEach, it, expect, vi } from "vitest";
import { withTenant, closeDb, jsonb } from "@gf/db";
import { buildContext } from "./actor";
import { buildServer } from "./server";
import { dispatch } from "./bus";
import { addDays, businessDateOf } from "@gf/scheduling";
vi.mock("./sms/flush", () => ({ flushSms: vi.fn(async () => {}) }));
vi.mock("./email/flush", () => ({ flushEmails: vi.fn(async () => {}) }));
const locationId = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const tenant = {
  orgId: "11111111-1111-4111-8111-111111111111",
  locationId,
  membershipId: null,
};
const path = "/v1/voice/%2B15125550199",
  caller = "+12025550123",
  other = "+12025550124";
const callStartedAt = new Date().toISOString();
let app: ReturnType<typeof buildServer>,
  ctx: Awaited<ReturnType<typeof buildContext>>,
  credential: string,
  serviceId: string,
  seq = 10;
const tokenId = (token: string) =>
  JSON.parse(Buffer.from(token.split(".")[0]!, "base64url").toString())
    .appointmentId;
const headers = (phone = caller, start = callStartedAt) => ({
  authorization: `Bearer ${credential}`,
  "x-gf-caller-number": phone,
  "x-gf-call-start-time": start,
});
const post = (action: string, body: unknown, h = headers()) =>
  app.inject({
    method: "POST",
    url: `${path}/appointments/${action}`,
    headers: h,
    payload: body as any,
  });
async function list(h = headers()) {
  const r = await app.inject({ url: `${path}/appointments`, headers: h });
  expect(r.statusCode).toBe(200);
  return r.json().appointments as any[];
}
async function make(phone = caller, email = "voice-manage@example.invalid") {
  const day = addDays(
    businessDateOf(new Date(), "America/New_York", "03:00"),
    seq++,
  );
  const offers = await app.inject({
    url: `${path}/context?date=${day}&serviceId=${serviceId}`,
    headers: headers(),
  });
  expect(offers.statusCode).toBe(200);
  const slot = offers.json().slots[0];
  expect(slot).toBeTruthy();
  const made = await app.inject({
    method: "POST",
    url: `${path}/bookings`,
    headers: headers(),
    payload: {
      slotToken: slot.slotToken,
      customerName: `Manage ${seq}`,
      phoneE164: phone,
      ...(email ? { email } : {}),
    },
  });
  expect(made.statusCode).toBe(200);
  const id = made.json().appointmentId;
  return {
    id,
    day,
    token: (await list(headers(phone))).find(
      (a) => tokenId(a.appointmentToken) === id,
    ).appointmentToken,
  };
}
async function availability(token: string, day: string) {
  const r = await post("availability", { appointmentToken: token, date: day });
  expect(r.statusCode).toBe(200);
  expect(r.json().slots.length).toBeGreaterThan(0);
  return r.json().slots;
}
async function state(id: string) {
  return (
    await withTenant(
      tenant,
      (tx) =>
        tx`select status,starts_at::text,self_reschedule_count from appointments where id=${id}`,
    )
  )[0]!;
}
async function noticeCounts(id: string) {
  return withTenant(tenant, async (tx) => ({
    sms: await tx`select body,to_e164,entity_type from sms_outbox where entity_id=${id} and kind='appointment_changed'`,
    email:
      await tx`select body_text,to_email,entity_type from email_outbox where entity_id=${id} and kind='appointment_changed'`,
  }));
}
beforeAll(async () => {
  const [m] = await withTenant(
    tenant,
    (tx) =>
      tx`select id,user_id from memberships where location_id=${locationId} and status='active' order by created_at limit 1`,
  );
  ctx = await buildContext({ userId: m!.user_id, membershipId: m!.id });
  credential = (
    await dispatch<{ toolToken: string }>(
      "location.savePhoneLine",
      {
        e164: "+15125550199",
        purpose: "ai_voice",
        active: true,
        rotateToolToken: true,
        aiAnswer: true,
        assistantId: "agent_test",
      },
      ctx,
      { systemOrigin: "test_voice" },
    )
  ).result.toolToken;
  const [svc] = await withTenant(
    tenant,
    (tx) =>
      tx`select id from services where location_id=${locationId} and active and not is_addon and staff_count=1 order by id limit 1`,
  );
  serviceId = svc!.id;
  await dispatch(
    "location.saveBookingPolicy",
    {
      mode: "location",
      baseCapacity: 2,
      bufferEnabled: false,
      bufferExtra: 1,
      requestBufferEnabled: false,
      requestBufferExtra: 1,
    },
    ctx,
  );
  await dispatch(
    "location.saveHours",
    {
      hours: Object.fromEntries(
        ["sun", "mon", "tue", "wed", "thu", "fri", "sat"].map((d) => [
          d,
          { open: "09:00", close: "20:00" },
        ]),
      ),
    },
    ctx,
  );
  await withTenant(
    tenant,
    (tx) => tx`update services set online_bookable=true where id=${serviceId}`,
  );
  await withTenant(
    tenant,
    (tx) =>
      tx`update locations set email='shop@example.invalid',phone='+16175550199',settings=jsonb_set(settings,'{public_booking_profile}','{"shopNotifications":{"email":true,"sms":true}}'::jsonb,true) where id=${locationId}`,
  );
  app = buildServer();
  await app.ready();
});
beforeEach(async () => {
  __resetAiRateLimit();
  __resetRateLimit();
  await withTenant(
    tenant,
    (tx) =>
      tx`update locations set settings=jsonb_set(settings,'{online_booking}',${jsonb({ enabled: true, min_minutes_ahead: 0, cancel_cutoff_hours: 4, reschedule_cutoff_hours: 4, self_reschedule_max: 2 })}::jsonb,true) where id=${locationId}`,
  );
});
afterAll(async () => {
  await app.close();
  await closeDb();
});
it("requires authenticated system caller metadata, never a model-supplied phone", async () => {
  expect((await app.inject({ url: `${path}/appointments` })).statusCode).toBe(
    401,
  );
  expect(
    (
      await app.inject({
        url: `${path}/appointments`,
        headers: { authorization: `Bearer ${credential}` },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await app.inject({
        url: `${path}/appointments?phoneE164=${other}`,
        headers: headers(),
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (
      await app.inject({
        url: `${path}/appointments`,
        headers: headers(
          caller,
          new Date(Date.now() - 25 * 60 * 60000).toISOString(),
        ),
      })
    ).statusCode,
  ).toBe(403);
});
it("lists only same-phone appointments, without contact data or automatic staff names", async () => {
  const mine = await make();
  await make(other);
  const rows = await list();
  expect(rows).toHaveLength(1);
  expect(
    JSON.parse(
      Buffer.from(
        rows[0].appointmentToken.split(".")[0],
        "base64url",
      ).toString(),
    ).appointmentId,
  ).toBe(mine.id);
  expect(
    rows.every(
      (r) => !JSON.stringify(r).includes("voice-manage@example.invalid"),
    ),
  ).toBe(true);
  expect(
    rows.every((r) => r.services.every((s: any) => !s.requestedSpecialist)),
  ).toBe(true);
  const foreign = await make(other);
  expect(
    (await post("cancel", { appointmentToken: foreign.token, confirmed: true }))
      .statusCode,
  ).toBe(404);
  expect((await state(foreign.id)).status).toBe("booked");
});
it("requires explicit confirmation, rejects token tampering and reuse in another call", async () => {
  const b = await make();
  expect((await post("cancel", { appointmentToken: b.token })).statusCode).toBe(
    400,
  );
  expect(
    (await post("cancel", { appointmentToken: b.token + "x", confirmed: true }))
      .statusCode,
  ).toBe(404);
  expect(
    (
      await post(
        "cancel",
        { appointmentToken: b.token, confirmed: true },
        headers(caller, new Date(Date.now() + 1000).toISOString()),
      )
    ).statusCode,
  ).toBe(404);
  expect((await state(b.id)).status).toBe("booked");
});
it("cancels once and sends the normal customer and shop SMS/email without AI wording", async () => {
  const b = await make();
  const before = await noticeCounts(b.id);
  expect(
    (await post("cancel", { appointmentToken: b.token, confirmed: true }))
      .statusCode,
  ).toBe(200);
  expect(
    (
      await post("cancel", { appointmentToken: b.token, confirmed: true })
    ).json().replayed,
  ).toBe(true);
  expect((await state(b.id)).status).toBe("cancelled");
  const activity=await withTenant(tenant,tx=>tx`select action,outcome from voice_appointment_activity where appointment_id=${b.id} and action='cancel'`);
  expect(activity).toEqual([{action:'cancel',outcome:'completed'}]);
  const n = await noticeCounts(b.id);
  expect(n.sms.length - before.sms.length).toBe(2);
  expect(n.email.length - before.email.length).toBe(2);
  const guest = n.sms.find((s) => s.to_e164 === caller)!;
  expect(guest.body).toContain("Canceled");
  expect(guest.body).not.toMatch(/AI|https?:/);
  expect(guest.body.length).toBeLessThanOrEqual(160);
  // Shop SMS is concise and link-free; authenticated management links live in email.
  expect(n.sms.find((s) => s.to_e164 === "+16175550199")!.body).not.toMatch(/https?:|\/b\//);
});
it("moves all items atomically and replays without extra counts or notifications", async () => {
  const b = await make();
  const slots = await availability(b.token, addDays(b.day, 1));
  const before = await noticeCounts(b.id);
  const body = { changeToken: slots[0].changeToken, confirmed: true };
  expect((await post("reschedule", body)).statusCode).toBe(200);
  expect((await post("reschedule", body)).json().replayed).toBe(true);
  const row = await state(b.id);
  expect(Date.parse(row.starts_at)).toBe(Date.parse(slots[0].startsAt));
  expect(row.self_reschedule_count).toBe(1);
  const after = await noticeCounts(b.id);
  expect(after.sms.length - before.sms.length).toBe(2);
  expect(after.email.length - before.email.length).toBe(2);
});
it("honors the same cutoff and reschedule limit as public self-service", async () => {
  const b = await make();
  await withTenant(
    tenant,
    (tx) =>
      tx`update appointments set self_reschedule_count=2 where id=${b.id}`,
  );
  const current = (await list()).find(
    (x) => tokenId(x.appointmentToken) === b.id,
  );
  const limited = await post("availability", {
    appointmentToken: current.appointmentToken,
    date: addDays(b.day, 1),
  });
  expect(limited.statusCode).toBe(403);
  expect(limited.json().details.reason).toBe("reschedule_limit_reached");
  await withTenant(
    tenant,
    (tx) =>
      tx`update locations set settings=jsonb_set(settings,'{online_booking,cancel_cutoff_hours}','2000'::jsonb) where id=${locationId}`,
  );
  const cancelled = await post("cancel", {
    appointmentToken: current.appointmentToken,
    confirmed: true,
  });
  expect(cancelled.statusCode).toBe(403);
  expect((await state(b.id)).status).toBe("booked");
});
it("rechecks phone ownership and stale selection at mutation time", async () => {
  const b = await make();
  await withTenant(
    tenant,
    (tx) =>
      tx`update customers set phone_e164=${other} where id=(select customer_id from appointments where id=${b.id})`,
  );
  expect(
    (await post("cancel", { appointmentToken: b.token, confirmed: true }))
      .statusCode,
  ).toBe(404);
  const c = await make();
  await withTenant(
    tenant,
    (tx) =>
      tx`update appointments set starts_at=starts_at+interval '30 minutes' where id=${c.id}`,
  );
  const r = await post("cancel", {
    appointmentToken: c.token,
    confirmed: true,
  });
  expect(r.statusCode).toBe(409);
  expect((await state(c.id)).status).toBe("booked");
});
it("missing email still sends a normal SMS and an independent shop email", async () => {
  const b = await make(caller, "");
  // The fixture phone may already have an email from an earlier booking: clear it explicitly.
  await withTenant(
    tenant,
    (tx) =>
      tx`update customers set email=null where id=(select customer_id from appointments where id=${b.id})`,
  );
  const before = await noticeCounts(b.id);
  expect(
    (await post("cancel", { appointmentToken: b.token, confirmed: true }))
      .statusCode,
  ).toBe(200);
  const n = await noticeCounts(b.id);
  expect(n.email.length - before.email.length).toBe(1);
  expect(n.sms.find((s) => s.to_e164 === caller)!.body).toContain("Call 617-555-0199");
});
it("also manages same-phone web and manual bookings, preserving an explicit SMS opt-out", async () => {
  const b = await make();
  await withTenant(
    tenant,
    (tx) => tx`update appointments set source='web' where id=${b.id}`,
  );
  await withTenant(
    tenant,
    (tx) =>
      tx`update appointment_items set details=details||'{"bookingSmsConsent":false}'::jsonb where appointment_id=${b.id}`,
  );
  const token = (await list()).find(
    (x) => tokenId(x.appointmentToken) === b.id,
  ).appointmentToken;
  expect(
    (await post("cancel", { appointmentToken: token, confirmed: true }))
      .statusCode,
  ).toBe(200);
  // Delivery suppression is enforced by the common SMS flusher; the stored consent is retained.
  const [item] = await withTenant(
    tenant,
    (tx) =>
      tx`select details from appointment_items where appointment_id=${b.id} limit 1`,
  );
  expect(item!.details.bookingSmsConsent).toBe(false);
  const manual = await make();
  await withTenant(
    tenant,
    (tx) =>
      tx`update appointments set source='phone_manual' where id=${manual.id}`,
  );
  const before = await noticeCounts(manual.id);
  expect(
    (await post("cancel", { appointmentToken: manual.token, confirmed: true }))
      .statusCode,
  ).toBe(200);
  expect((await noticeCounts(manual.id)).sms.length - before.sms.length).toBe(
    2,
  );
});
it("refuses a stale offered slot when another booking takes its capacity", async () => {
  const b = await make();
  const date = addDays(b.day, 2),
    slots = await availability(b.token, date),
    target = slots[0];
  // Reduce location capacity to one and occupy the exact advertised interval.
  await dispatch(
    "location.saveBookingPolicy",
    {
      mode: "location",
      baseCapacity: 1,
      bufferEnabled: false,
      bufferExtra: 1,
      requestBufferEnabled: false,
      requestBufferExtra: 1,
    },
    ctx,
  );
  const offers = await app.inject({
    url: `${path}/context?date=${date}&serviceId=${serviceId}`,
    headers: headers(),
  });
  const offered = offers
    .json()
    .slots.find(
      (s: any) => Date.parse(s.startsAt) === Date.parse(target.startsAt),
    );
  expect(offered).toBeTruthy();
  const occupied = await app.inject({
    method: "POST",
    url: `${path}/bookings`,
    headers: headers(),
    payload: {
      slotToken: offered.slotToken,
      customerName: "Other guest",
      phoneE164: other,
    },
  });
  expect(occupied.statusCode).toBe(200);
  const before = await state(b.id);
  const move = await post("reschedule", {
    changeToken: target.changeToken,
    confirmed: true,
  });
  expect(move.statusCode).toBe(409);
  expect((await state(b.id)).starts_at).toBe(before.starts_at);
});
it("checks the verified phone again inside the mutation transaction", async () => {
  const b = await make();
  const row = await state(b.id);
  await expect(
    dispatch(
      "appointment.cancel",
      {
        appointmentId: b.id,
        reason: "guest_changed_mind",
        keepStaffTurn: false,
      },
      {
        ...ctx,
        userId: null,
        membershipId: null,
        verifiedBookingCaller: {
          phoneE164: other,
          expectedStartsAt: row.starts_at,
          expectedRescheduleCount: row.self_reschedule_count,
        },
      },
    ),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect((await state(b.id)).status).toBe("booked");
});

it('links lookup and cancellation of a web booking to its recorded call without replacing the booking origin',async()=>{
 const b=await make();
 await withTenant(tenant,tx=>tx`update appointments set source='web',provider_call_id=null where id=${b.id}`);
 await list();
 expect((await post('cancel',{appointmentToken:b.token,confirmed:true})).statusCode).toBe(200);
 const scoped={...ctx,permissions:new Set([...ctx.permissions,'call.draft' as const])};
 await dispatch('call.queueRecording',{providerCallId:'management-recording',recordingId:'management-audio',to:'+15125550199',from:caller,startedAt:callStartedAt,durationSeconds:600},scoped,{systemOrigin:'voice_test'});
 const activities=await withTenant(tenant,tx=>tx`select v.action,v.outcome,p.provider_call_id from voice_appointment_activity v join phone_calls p on p.id=v.call_id where v.appointment_id=${b.id} order by v.action`);
 expect(activities).toEqual([{action:'cancel',outcome:'completed',provider_call_id:'management-recording'},{action:'lookup',outcome:'requested',provider_call_id:'management-recording'}]);
 const [origin]=await withTenant(tenant,tx=>tx`select source,provider_call_id from appointments where id=${b.id}`);
 expect(origin).toEqual({source:'web',provider_call_id:null});
});
