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
  const replay = await book(offer, "Mixed party");
  expect(replay.json().appointmentId).toBe(booked.json().appointmentId);
  expect(replay.json().replayed).toBe(true);
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
  const { refreshVoiceSnapshot } = await import("./voice/contextCache");
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
