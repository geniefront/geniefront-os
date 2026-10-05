import { __resetAiRateLimit } from "./billing/aiAdmission";
import { __resetRateLimit } from "./public/rateLimit";
import { beforeAll, afterAll, beforeEach, it, expect } from "vitest";
import { withTenant, closeDb } from "@gf/db";
import { buildContext } from "./actor";
import { buildServer } from "./server";
import { dispatch } from "./bus";
import { addDays, businessDateOf } from "@gf/scheduling";
import { compactTimes } from "./voice/selection";
const locationId = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const tenant = {
  orgId: "11111111-1111-4111-8111-111111111111",
  locationId,
  membershipId: null,
};
const path = "/v1/voice/%2B15125550198";
let app: ReturnType<typeof buildServer>,
  token: string,
  services: string[],
  addon: string,
  staff: string[];
const caller = "+12025550123",
  start = new Date().toISOString();
const date = addDays(
  businessDateOf(new Date(), "America/New_York", "00:00"),
  12,
);
const headers = () => ({
  authorization: `Bearer ${token}`,
  "x-gf-caller-number": caller,
  "x-gf-call-start-time": start,
});
beforeEach(() => {
  __resetAiRateLimit();
  __resetRateLimit();
});
beforeAll(async () => {
  const [m] = await withTenant(
    tenant,
    (tx) =>
      tx`select id,user_id from memberships where location_id=${locationId} and status='active' order by created_at limit 1`,
  );
  const ctx = await buildContext({ userId: m!.user_id, membershipId: m!.id });
  const bound = await dispatch<{ toolToken: string }>(
    "location.savePhoneLine",
    {
      e164: "+15125550198",
      purpose: "ai_voice",
      active: true,
      rotateToolToken: true,
      aiAnswer: true,
      assistantId: "agent_test",
    },
    ctx,
    { systemOrigin: "test_voice" },
  );
  token = bound.result.toolToken;
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
  await dispatch(
    "location.saveBookingPolicy",
    {
      mode: "location",
      baseCapacity: 5,
      bufferEnabled: false,
      bufferExtra: 1,
      requestBufferEnabled: false,
      requestBufferExtra: 1,
    },
    ctx,
  );
  await withTenant(tenant, async (tx) => {
    await tx`update locations set settings=jsonb_set(settings,'{capacity,use_recurring_staff}','true'::jsonb) where id=${locationId}`;
    const rows =
      await tx`select id from services where location_id=${locationId} and active and not is_addon and staff_count=1 order by id limit 2`;
    services = rows.map((r) => r.id);
    const [a] =
      await tx`select id from services where location_id=${locationId} and active and is_addon order by id limit 1`;
    addon = a!.id;
    await tx`update services set online_bookable=true where id=any(${[...services, addon]})`;
    staff = (
      await tx`select sp.membership_id from staff_profiles sp join memberships m on m.id=sp.membership_id where sp.location_id=${locationId} and sp.is_bookable and m.status='active' order by sp.membership_id`
    ).map((r) => r.membership_id);
    // Give deterministic eligibility for this integration fixture only.
    await tx`delete from service_skill_requirements where location_id=${locationId} and service_id=any(${[...services, addon]})`;
  });
  app = buildServer();
  await app.ready();
  // Production prewarming belongs to a separate process. Explicitly run its
  // calculation in this isolated DB fixture instead of relying on a GET to do it.
  const { refreshVoiceSnapshot } = await import('./voice/snapshotRefresh');
  const { hashToolToken } = await import('./telnyx/toolToken');
  await refreshVoiceSnapshot(ctx, hashToolToken(token), true);
});
afterAll(async () => {
  await app?.close();
  await closeDb();
});
const get = (query = "") =>
  app.inject({
    method: "GET",
    url: `${path}/context-v2${query ? "?" + query : ""}`,
    headers: headers(),
  });
const search = async (items: unknown, day = date) => {
  const r = await get(
    new URLSearchParams({
      date: day,
      itemsJson: JSON.stringify(items),
    }).toString(),
  );
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
};
const firstTime = (offer: any) => offer.times[0].split(/[-,/]/)[0];
const book = (offer: any, name: string, time = firstTime(offer)) =>
  app.inject({
    method: "POST",
    url: `${path}/bookings-v2`,
    headers: headers(),
    payload: {
      slotToken: offer.slotToken,
      priceConfirmed: true,
      confirmedTotalCents: offer.priceCents,
      time,
      customerName: name,
      phoneE164: caller,
    },
  });
it("compacts only consecutive times without inventing gaps", () => {
  expect(
    compactTimes(["09:00", "09:15", "09:30", "10:00", "10:15"], 15),
  ).toEqual(["09:00-09:30/15", "10:00,10:15"]);
});
it("initializes seven days, addons, staff skills and own appointments without oversized JSON", async () => {
  const r = await get();
  expect(r.statusCode, r.body).toBe(200);
  const b = r.json();
  expect(b.coverage.through).toBe(addDays(b.coverage.from, 6));
  expect(b.coverage.complete).toBe(true);
  expect(b.services.some((s: any) => s.serviceId === addon && s.isAddon)).toBe(
    true,
  );
  expect(b.staff[0].serviceIds).toContain(services[0]);
  expect(b.callerAppointments.ok).toBe(true);
  expect(Buffer.byteLength(r.body)).toBeLessThan(14500);
  expect(b.guidance).toBeUndefined();
  const noCaller = await app.inject({
    method: "GET",
    url: `${path}/context-v2`,
    headers: { authorization: `Bearer ${token}` },
  });
  expect(noCaller.json().callerAppointments.status).toBe("caller_unverified");
});
it("books different services and an addon for two guests, preserving requested vs automatic staff and retrying idempotently", async () => {
  const items = [
    {
      guestIndex: 0,
      serviceId: services[0],
      addonIds: [addon],
      staffId: staff[0],
    },
    { guestIndex: 1, serviceId: services[1] },
  ];
  const result = await search(items);
  const offer = result.offers[0];
  expect(offer).toBeTruthy();
  const booked = await book(offer, "Mixed party");
  expect(booked.statusCode, booked.body).toBe(200);
  expect(booked.json()).not.toHaveProperty('confirmationCode');
  // A retry may replay a response cached before confirmation codes were retired.
  await withTenant(tenant, (tx) => tx`
    update command_idempotency
       set result_json = result_json || '{"confirmationCode":"GF-OLD2"}'::jsonb
     where location_id = ${locationId} and command = 'voice.submitBooking'
       and result_json->>'appointmentId' = ${booked.json().appointmentId}`);
  const replay = await book(offer, "Mixed party");
  expect(replay.json().appointmentId).toBe(booked.json().appointmentId);
  expect(replay.json().replayed).toBe(true);
  expect(replay.json()).not.toHaveProperty('confirmationCode');
  const rows = await withTenant(
    tenant,
    (tx) =>
      tx`select service_id,addon_ids,is_request,membership_id,reserved_membership_id,duration_min,details from appointment_items where appointment_id=${booked.json().appointmentId} order by seq`,
  );
  expect(rows).toHaveLength(2);
  expect(rows[0]!.addon_ids).toContain(addon);
  expect(rows[0]!.is_request).toBe(true);
  expect(rows[1]!.is_request).toBe(false);
  expect(rows[0]!.membership_id).toBe(staff[0]);
  const refreshed = await get();
  expect(
    refreshed
      .json()
      .callerAppointments.appointments.some(
        (a: any) =>
          a.guests === 2 && a.services.some((i: any) => i.addons.length),
      ),
  ).toBe(true);
  const short = refreshed
    .json()
    .callerAppointments.appointments.find(
      (a: any) => a.guests === 2,
    ).appointmentToken;
  expect(short).toHaveLength(16);
  const other = await app.inject({
    method: "POST",
    url: `${path}/appointments-v2/cancel`,
    headers: { ...headers(), "x-gf-caller-number": "+12025550999" },
    payload: { appointmentToken: short, confirmed: true },
  });
  expect(other.statusCode).toBe(404);
});
it("does not offer simultaneous appointments with the same required therapist", async () => {
  const result = await search(
    [
      { guestIndex: 0, serviceId: services[0], staffId: staff[0] },
      { guestIndex: 1, serviceId: services[1], staffId: staff[0] },
    ],
    addDays(date, 1),
  );
  expect(result.offers).toEqual([]);
  expect(result.unavailable[0].reason).toBe("no_availability");
});
it("rejects an unoffered time, malformed reference and invalid calendar date", async () => {
  const result = await search(
    [{ guestIndex: 0, serviceId: services[0] }],
    addDays(date, 2),
  );
  expect((await book(result.offers[0], "Bad time", "03:17")).statusCode).toBe(
    400,
  );
  expect(
    (await book({ ...result.offers[0], slotToken: "bad" }, "Bad ref"))
      .statusCode,
  ).toBe(400);
  expect(
    (
      await get(
        new URLSearchParams({
          date: "2026-02-30",
          serviceId: services[0]!,
        }).toString(),
      )
    ).statusCode,
  ).toBe(400);
});
it("rejects changed prices before committing and accepts a freshly quoted selection", async () => {
  const items = [{ guestIndex: 0, serviceId: services[0] }];
  const result = await search(items, addDays(date, 3));
  await withTenant(
    tenant,
    (tx) =>
      tx`update services set base_price_cents=base_price_cents+100 where id=${services[0]!}`,
  );
  const r = await book(result.offers[0], "Changed price");
  expect(r.statusCode, r.body).toBe(409);
  expect(r.json().details.reason).toBe("price_changed_query_again");
  const fresh = await search(items, addDays(date, 3));
  expect((await book(fresh.offers[0], "Changed price")).statusCode).toBe(200);
});
it("short management references support whole-party rescheduling and cancellation", async () => {
  const offer = (
    await search(
      [{ guestIndex: 0, serviceId: services[0], addonIds: [addon] }],
      addDays(date, 4),
    )
  ).offers[0];
  const booked = await book(offer, "Manage addon");
  expect(booked.statusCode, booked.body).toBe(200);
  const post = (action: string, payload: unknown) =>
    app.inject({
      method: "POST",
      url: `${path}/appointments-v2/${action}`,
      headers: headers(),
      payload: payload as any,
    });
  const list = await post("lookup", {});
  const selected = list
    .json()
    .appointments.find(
      (a: any) => Date.parse(a.startsAt) === Date.parse(booked.json().startsAt),
    );
  expect(selected).toBeTruthy();
  const avail = await post("availability", {
    appointmentToken: selected.appointmentToken,
    date: addDays(date, 5),
  });
  expect(avail.statusCode, avail.body).toBe(200);
  const moved = await post("reschedule", {
    changeToken: avail.json().slots[0].changeToken,
    confirmed: true,
  });
  expect(moved.statusCode, moved.body).toBe(200);
  const replay = await post("reschedule", {
    changeToken: avail.json().slots[0].changeToken,
    confirmed: true,
  });
  expect(replay.json().replayed).toBe(true);
  const refreshed = await post("lookup", {});
  const current = refreshed
    .json()
    .appointments.find(
      (a: any) => Date.parse(a.startsAt) === Date.parse(moved.json().startsAt),
    );
  const cancelled = await post("cancel", {
    appointmentToken: current.appointmentToken,
    confirmed: true,
  });
  expect(cancelled.statusCode, cancelled.body).toBe(200);
});
it("maps 14:00 to the actual offered instant and never to noon", async () => {
  const data = await search(
    [{ guestIndex: 0, serviceId: services[0] }],
    addDays(date, 6),
  );
  const booked = await book(data.offers[0], "Two pm regression", "14:00");
  expect(booked.statusCode, booked.body).toBe(200);
  expect(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "America/New_York",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(booked.json().startsAt)),
  ).toBe("14:00");
});
it("does not partially book a group when a required therapist becomes unavailable", async () => {
  const day = addDays(date, 7);
  const group = await search(
    [
      { guestIndex: 0, serviceId: services[0], staffId: staff[0] },
      { guestIndex: 1, serviceId: services[1], staffId: staff[1] },
    ],
    day,
  );
  const single = await search(
    [{ guestIndex: 0, serviceId: services[0], staffId: staff[0] }],
    day,
  );
  expect(
    (await book(single.offers[0], "Takes required staff")).statusCode,
  ).toBe(200);
  const rejected = await book(group.offers[0], "Must be atomic");
  expect(rejected.statusCode).toBe(409);
  const rows = await withTenant(
    tenant,
    (tx) =>
      tx`select a.id from appointments a join customers c on c.id=a.customer_id where a.location_id=${locationId} and c.display_name='Must be atomic'`,
  );
  expect(rows).toHaveLength(0);
});
it("isolates stored references from another tenant and expires them", async () => {
  const offer = (
    await search([{ guestIndex: 0, serviceId: services[0] }], addDays(date, 8))
  ).offers[0];
  const id = offer.slotToken.split(".")[0];
  const invisible = await withTenant(
    { ...tenant, locationId: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb" },
    (tx) => tx`select id from voice_context_references where id=${id}`,
  );
  expect(invisible).toHaveLength(0);
  // app_user can delete its expiring references but has no broad update access.
  await withTenant(
    tenant,
    (tx) => tx`delete from voice_context_references where id=${id}`,
  );
  const result = await book(offer, "Expired reference");
  expect(result.statusCode).toBe(400);
  expect(result.json().details.reason).toBe("selection_expired_query_again");
});

it("publishes store-only snapshots and invalidates catalog changes once per transaction", async () => {
  const { refreshVoiceSnapshot } = await import("./voice/snapshotRefresh");
  const { hashToolToken } = await import("./telnyx/toolToken");
  const { readInitialSnapshot } = await import("./voice/references");
  const ctx = {
    ...tenant,
    userId: null,
    actorKind: "api" as const,
    locale: "en" as const,
    timezone: "America/New_York",
    permissions: new Set(["appointment.write" as const, "call.draft" as const]),
  };
  expect(await refreshVoiceSnapshot(ctx, hashToolToken(token), true)).toBe(
    true,
  );
  const before = await withTenant(ctx, (tx) => readInitialSnapshot(tx, ctx));
  expect(before!.clean).toBe(true);
  expect((before!.payload as any).callerAppointments).toBeUndefined();
  await withTenant(ctx, async (tx) => {
    await tx`update services set base_price_cents=base_price_cents+1 where id=${services[0]!}`;
    await tx`update services set base_price_cents=base_price_cents-1 where id=${services[0]!}`;
  });
  const dirty = await withTenant(ctx, (tx) => readInitialSnapshot(tx, ctx));
  expect(BigInt(dirty!.revision) - BigInt(before!.revision)).toBe(1n);
  expect(dirty!.clean).toBe(false);
  const cached = await get();
  expect(cached.statusCode).toBe(200);
  expect(cached.json().coverage.stale).toBe(true);
  expect(cached.json().coverage.generatedAt).toBe(
    (before!.payload as any).coverage.generatedAt,
  );
  expect(await refreshVoiceSnapshot(ctx, hashToolToken(token), true)).toBe(
    true,
  );
  expect((await get()).json().coverage.stale).toBe(false);
});
it("coordinates refresh across workers and rejects an expired lease owner", async () => {
  const { claimInitialSnapshot, publishInitialSnapshot, readInitialSnapshot } =
    await import("./voice/references");
  const ctx = {
    ...tenant,
    userId: null,
    actorKind: "api" as const,
    locale: "en" as const,
    timezone: "America/New_York",
    permissions: new Set(["appointment.write" as const, "call.draft" as const]),
  };
  const row = await withTenant(ctx, (tx) => readInitialSnapshot(tx, ctx));
  const claims = await Promise.all([
    withTenant(ctx, (tx) => claimInitialSnapshot(tx, ctx, row!.scope, true)),
    withTenant(ctx, (tx) => claimInitialSnapshot(tx, ctx, row!.scope, true)),
  ]);
  expect(claims.filter(Boolean)).toHaveLength(1);
  const lease = claims.find(Boolean)!;
  await withTenant(
    ctx,
    (tx) =>
      tx`update voice_availability_snapshots set lease_until=now()-interval '1 second' where location_id=${locationId}`,
  );
  const replacement = await withTenant(ctx, (tx) =>
    claimInitialSnapshot(tx, ctx, row!.scope, true),
  );
  expect(replacement).toBeTruthy();
  expect(
    await withTenant(ctx, (tx) =>
      publishInitialSnapshot(tx, ctx, row!.scope, lease, row!.payload),
    ),
  ).toBe(false);
  expect(
    await withTenant(ctx, (tx) =>
      publishInitialSnapshot(tx, ctx, row!.scope, replacement!, row!.payload),
    ),
  ).toBe(true);
});

it('queues a missing snapshot and lets the worker populate it without booking anything', async () => {
  const { refreshVoiceSnapshot } = await import('./voice/snapshotRefresh');
  const { hashToolToken } = await import('./telnyx/toolToken');
  const ctx = { ...tenant, userId: null, actorKind: 'api' as const, locale: 'en' as const,
    timezone: 'America/New_York', permissions: new Set(['appointment.write' as const, 'call.draft' as const]) };
  await withTenant(ctx, tx => tx`delete from voice_availability_snapshots where location_id=${locationId}`);
  const cold = await get();
  expect(cold.statusCode).toBe(503);
  expect(cold.json().details).toMatchObject({ reason: 'context_refreshing', retryable: true });
  const [queued] = await withTenant(ctx, tx => tx`select payload,lease_id from voice_availability_snapshots where location_id=${locationId}`);
  expect(queued).toMatchObject({ payload: null, lease_id: null });
  expect(await refreshVoiceSnapshot(ctx, hashToolToken(token))).toBe(true);
  expect((await get()).statusCode).toBe(200);
});

it('a cold-cache enqueue preserves an existing lease and failure backoff', async () => {
  const { requestInitialSnapshot, claimInitialSnapshot, failInitialSnapshot, readInitialSnapshot } = await import('./voice/references');
  const ctx = { ...tenant, userId: null, actorKind: 'api' as const, locale: 'en' as const,
    timezone: 'America/New_York', permissions: new Set(['appointment.write' as const, 'call.draft' as const]) };
  const before = await withTenant(ctx, tx => readInitialSnapshot(tx, ctx));
  const lease = await withTenant(ctx, tx => claimInitialSnapshot(tx, ctx, before!.scope, true));
  await withTenant(ctx, tx => requestInitialSnapshot(tx, ctx, before!.scope, true));
  expect(await withTenant(ctx, tx => claimInitialSnapshot(tx, ctx, before!.scope, true))).toBeNull();
  await withTenant(ctx, tx => failInitialSnapshot(tx, ctx, lease!.leaseId));
  const failed = await withTenant(ctx, tx => readInitialSnapshot(tx, ctx));
  await withTenant(ctx, tx => requestInitialSnapshot(tx, ctx, before!.scope, true));
  const after = await withTenant(ctx, tx => readInitialSnapshot(tx, ctx));
  expect(after!.retryAfter).toBe(failed!.retryAfter);
  expect(after!.payload).toEqual(before!.payload);
  expect(after!.revision).toBe(before!.revision);
  expect(await withTenant(ctx, tx => claimInitialSnapshot(tx, ctx, before!.scope, true))).toBeNull();
  await withTenant(ctx, tx => tx`update voice_availability_snapshots set retry_after=now() where location_id=${locationId}`);
});
it("does not lose a booking or schedule invalidation that arrives while a refresh is running", async () => {
  const { claimInitialSnapshot, publishInitialSnapshot, readInitialSnapshot } =
    await import("./voice/references");
  const ctx = {
    ...tenant,
    userId: null,
    actorKind: "api" as const,
    locale: "en" as const,
    timezone: "America/New_York",
    permissions: new Set(["appointment.write" as const, "call.draft" as const]),
  };
  const before = await withTenant(ctx, (tx) => readInitialSnapshot(tx, ctx));
  const lease = await withTenant(ctx, (tx) =>
    claimInitialSnapshot(tx, ctx, before!.scope, true),
  );
  await withTenant(
    ctx,
    (tx) =>
      tx`update staff_profiles set is_bookable=is_bookable where membership_id=${staff[0]!}`,
  );
  expect(
    await withTenant(ctx, (tx) =>
      publishInitialSnapshot(tx, ctx, before!.scope, lease!, before!.payload),
    ),
  ).toBe(true);
  const after = await withTenant(ctx, (tx) => readInitialSnapshot(tx, ctx));
  expect(after!.clean).toBe(false);
  expect(Date.parse(after!.refreshAfter) - Date.now()).toBeLessThan(2100);
});
it("retains the last complete snapshot after refresh failure and marks it stale", async () => {
  const { claimInitialSnapshot, failInitialSnapshot, readInitialSnapshot } =
    await import("./voice/references");
  const ctx = {
    ...tenant,
    userId: null,
    actorKind: "api" as const,
    locale: "en" as const,
    timezone: "America/New_York",
    permissions: new Set(["appointment.write" as const, "call.draft" as const]),
  };
  const row = await withTenant(ctx, (tx) => readInitialSnapshot(tx, ctx));
  const lease = await withTenant(ctx, (tx) =>
    claimInitialSnapshot(tx, ctx, row!.scope, true),
  );
  await withTenant(ctx, (tx) => failInitialSnapshot(tx, ctx, lease!.leaseId));
  const after = await withTenant(ctx, (tx) => readInitialSnapshot(tx, ctx));
  expect(after!.payload).toEqual(row!.payload);
  expect(Date.parse(after!.retryAfter)).toBeGreaterThan(Date.now());
  expect((await get()).json().coverage.stale).toBe(true);
  await withTenant(
    ctx,
    (tx) =>
      tx`update voice_availability_snapshots set retry_after=now() where location_id=${locationId}`,
  );
});
it("rejects old-date, over-age and different-credential snapshots and isolates other tenants", async () => {
  const { usableSnapshot } = await import("./voice/contextCache");
  const { readInitialSnapshot } = await import("./voice/references");
  const row = await withTenant(tenant, (tx) =>
    readInitialSnapshot(tx, tenant as any),
  );
  expect(usableSnapshot(row, row!.scope)).toBe(true);
  expect(usableSnapshot(row, "wrong-scope")).toBe(false);
  expect(
    usableSnapshot(
      { ...row!, generatedAt: new Date(Date.now() - 301000).toISOString() },
      row!.scope,
    ),
  ).toBe(false);
  const wrongDate = structuredClone(row!);
  (wrongDate.payload as any).coverage.from = "2000-01-01";
  expect(usableSnapshot(wrongDate, row!.scope)).toBe(false);
  const other = await withTenant(
    { ...tenant, locationId: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb" },
    (tx) =>
      tx`select location_id from voice_availability_snapshots where location_id=${locationId}`,
  );
  expect(other).toHaveLength(0);
});
it("bulk snapshot availability matches fresh single-selection planning", async () => {
  const { voiceCatalog } = await import("./voice/catalog");
  const { loadPartyAvailability } = await import("./public/partyAvailability");
  const { loadPartyAvailabilityData } = await import(
    "./public/partyAvailabilityData"
  );
  await withTenant(tenant, async (tx) => {
    const cat = await voiceCatalog(tx, locationId);
    const day = addDays(date, 10);
    const data = await loadPartyAvailabilityData(tx, cat.shop, [day]);
    for (const items of [
      [
        {
          guestIndex: 0,
          serviceId: services[0]!,
          addonIds: [addon],
          staffId: staff[0]!,
        },
      ],
      [
        { guestIndex: 0, serviceId: services[0]!, addonIds: [], staffId: null },
        { guestIndex: 1, serviceId: services[1]!, addonIds: [], staffId: null },
      ],
    ]) {
      const direct = await loadPartyAvailability(tx, cat.shop, {
        date: day,
        items,
      });
      const batched = await loadPartyAvailability(
        tx,
        cat.shop,
        { date: day, items },
        data,
      );
      expect(batched.plans.map((p) => p.startsAt)).toEqual(
        direct.plans.map((p) => p.startsAt),
      );
      expect(
        batched.items.map((i) => [
          i.durationMin,
          i.priceCents,
          i.eligibleStaffIds,
        ]),
      ).toEqual(
        direct.items.map((i) => [
          i.durationMin,
          i.priceCents,
          i.eligibleStaffIds,
        ]),
      );
    }
  });
});

it('requires actual price agreement and an exact full total before any booking write', async () => {
  const offer=(await search([{guestIndex:0,serviceId:services[0]}],addDays(date,20))).offers[0];
  const payload={slotToken:offer.slotToken,time:firstTime(offer),customerName:'Price gate',phoneE164:caller};
  for (const confirmation of [{}, {priceConfirmed:false,confirmedTotalCents:offer.priceCents}, {priceConfirmed:true}, {priceConfirmed:true,confirmedTotalCents:offer.priceCents+1}]) {
    const result=await app.inject({method:'POST',url:`${path}/bookings-v2`,headers:headers(),payload:{...payload,...confirmation}});
    expect(result.statusCode,result.body).toBe(400);
    expect(['price_confirmation_required','confirmed_price_mismatch']).toContain(result.json().details.reason);
  }
  const rows=await withTenant(tenant,tx=>tx`select a.id from appointments a join customers c on c.id=a.customer_id where a.location_id=${locationId} and c.display_name='Price gate'`);
  expect(rows).toHaveLength(0);
  const confirmed=await book(offer,'Price gate');
  expect(confirmed.statusCode,confirmed.body).toBe(200);
  expect(confirmed.json().priceCents).toBe(offer.priceCents);
});

it('books one couples session for $120 and rejects duplicate groups including pre-existing tokens',async()=>{
  const [m]=await withTenant(tenant,tx=>tx`select id,user_id from memberships where location_id=${locationId} and status='active' order by created_at limit 1`);
  const ctx=await buildContext({userId:m!.user_id,membershipId:m!.id});
  const made=await dispatch<{serviceId:string}>('catalog.saveService',{name:{en:'Couples Massage 60 min'},durationMin:60,basePriceCents:12000,staffCount:2,onlineBookable:true},ctx);
  const serviceId=made.result.serviceId;
  const day=addDays(date,21);
  const selected=await search([{serviceId,guestIndices:[0,1]}],day);
  expect(selected.selection).toHaveLength(1);
  expect(selected.selection[0].guestIndex).toBe(0);
  const offer=selected.offers[0];
  expect(offer.priceCents).toBe(12000);
  const simple=await get(new URLSearchParams({date:day,serviceId,partySize:'2'}).toString());
  expect(simple.statusCode,simple.body).toBe(200);
  expect(simple.json().selection).toHaveLength(1);
  expect(simple.json().offers[0].priceCents).toBe(12000);
  const duplicate=[{serviceId,guestIndex:0,guestIndices:[0,1]},{serviceId,guestIndex:1,guestIndices:[0,1]}];
  const invalid=await get(new URLSearchParams({date:day,itemsJson:JSON.stringify(duplicate)}).toString());
  expect(invalid.statusCode).toBe(400);
  expect(invalid.json().details.reason).toBe('duplicate_shared_service');
  const malformed=await get(new URLSearchParams({date:day,itemsJson:JSON.stringify([{serviceId}])}).toString());
  expect(malformed.json().details.issues[0].path).toBe('0.guestIndex');
  expect(malformed.json().details.guidance).toBeTruthy();
  // A reference already minted by the old API must not bypass the write-time guard.
  const { saveReference, referenceScope }=await import('./voice/references');
  const { hashToolToken }=await import('./telnyx/toolToken');
  const time=firstTime(offer);
  const { wallMinuteToInstant }=await import('@gf/scheduling');
  const startsAt=wallMinuteToInstant(day,'America/New_York',Number(time.slice(0,2))*60+Number(time.slice(3,5))).toISOString();
  const legacyId=await withTenant(ctx,tx=>saveReference(tx,ctx,'offers',referenceScope(hashToolToken(token)),[{date:day,items:duplicate.map(i=>({...i,addonIds:[],staffId:null})),times:[time],startsAtByTime:{[time]:startsAt},quotedTotalCents:24000,timezone:'America/New_York'}]));
  const legacy=await book({...offer,slotToken:`${legacyId}.0`,priceCents:24000},'Duplicate must fail');
  expect(legacy.statusCode,legacy.body).toBe(400);
  expect(legacy.json().details.reason).toBe('duplicate_shared_service');
  const booked=await book(offer,'One couples session');
  expect(booked.statusCode,booked.body).toBe(200);
  const [row]=await withTenant(tenant,tx=>tx`select a.party_size,extract(epoch from (a.ends_at-a.starts_at))/60 as minutes,sum(i.price_cents_snapshot)::int as total,count(*)::int as staff_items from appointments a join appointment_items i on i.appointment_id=a.id where a.id=${booked.json().appointmentId} group by a.id`);
  expect(row).toMatchObject({party_size:2,total:12000,staff_items:2});
  expect(Number(row!.minutes)).toBe(60);
});

it('saves a five-minute lead time with ten-minute offers and answers the exact requested slot', async () => {
  const [m] = await withTenant(tenant, tx => tx`select id,user_id from memberships where location_id=${locationId} and status='active' order by created_at limit 1`);
  const ctx = await buildContext({ userId: m!.user_id, membershipId: m!.id });
  const [before] = await withTenant(tenant, tx => tx`select settings->'online_booking' as rules from locations where id=${locationId}`);
  try {
    await dispatch('settings.saveVoiceBookingRules', { maxDaysAhead:60, minMinutesAhead:5, slotIntervalMinutes:10 }, ctx);
    const [saved] = await withTenant(tenant, tx => tx`select settings->'online_booking' as rules from locations where id=${locationId}`);
    expect(saved!.rules).toMatchObject({ min_minutes_ahead:5, slot_interval_minutes:10 });
    const query = new URLSearchParams({ date:addDays(date,9), serviceId:services[0]!, time:'09:10' });
    const result = await get(query.toString());
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json().requestedTime).toMatchObject({ time:'09:10', available:true, reason:null });
    expect(result.json().offers[0].times.join(',')).toContain('/10');
    query.set('time', '09:15');
    expect((await get(query.toString())).json().requestedTime).toMatchObject({ available:false, reason:'not_offered', alternatives:['09:10','09:20'] });
    query.set('time', '25:70');
    expect((await get(query.toString())).statusCode).toBe(400);
    expect((await get('time=09:10')).statusCode).toBe(400);
    const booked = await book(result.json().offers[0], 'Ten-minute grid', '09:10');
    expect(booked.statusCode, booked.body).toBe(200);
    // Existing clients that omit the optional interval must preserve it.
    await dispatch('settings.saveVoiceBookingRules', { maxDaysAhead:60, minMinutesAhead:5 }, ctx);
    const [preserved] = await withTenant(tenant, tx => tx`select settings->'online_booking'->>'slot_interval_minutes' as step from locations where id=${locationId}`);
    expect(preserved!.step).toBe('10');
  } finally {
    await withTenant(tenant, tx => tx`update locations set settings=jsonb_set(settings,'{online_booking}',${JSON.stringify(before!.rules)}::jsonb) where id=${locationId}`);
  }
});
