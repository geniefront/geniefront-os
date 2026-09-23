import '../handlers/voiceActivity';
import { saveReference, readReference, referenceScope } from "./references";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { createHmac, timingSafeEqual, createHash } from "node:crypto";
import { z } from "zod";
import {
  AppError,
  ERROR_CODES,
  phoneE164,
  pickText,
  type CommandContext,
} from "@gf/contracts";
import {
  withTenant,
  readOnlineBooking,
  type OnlineBookingConfig,
} from "@gf/db";
import {
  guestActions,
  guestCancelBlockReason,
  guestRescheduleBlockReason,
} from "../public/managedDetail";
import { loadManagedAvailability } from "../public/managedAvailability";
import { dispatch } from "../bus";
import { flushSms } from "../sms/flush";
import { flushEmails } from "../email/flush";
import "../handlers/appointment";

type Auth = (
  req: FastifyRequest,
) => Promise<{ ctx: CommandContext; secret: string }>;
const tokenSchema = z
  .object({
    appointmentId: z.string().uuid(),
    locationId: z.string().uuid(),
    caller: z.string(),
    callStartedAt: z.string(),
    startsAt: z.string(),
    count: z.number().int().min(0),
    expiresAt: z.number(),
    action: z.enum(["select", "reschedule"]),
    target: z.string().optional(),
  })
  .strict();
type Token = z.infer<typeof tokenSchema>;
const token = z.string().min(16).max(3000);
const selectBody = z
  .object({
    appointmentToken: token,
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .strict();
const cancelBody = z
  .object({ appointmentToken: token, confirmed: z.literal(true) })
  .strict();
const rescheduleBody = z
  .object({ changeToken: token, confirmed: z.literal(true) })
  .strict();
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const p = schema.safeParse(input);
  if (!p.success) throw new AppError(ERROR_CODES.VALIDATION_FAILED);
  return p.data;
}
const mac = (data: string, secret: string) =>
  createHmac("sha256", secret)
    .update(`voice-manage:${data}`)
    .digest("base64url");
const encode = (data: Token, secret: string) => {
  const raw = Buffer.from(JSON.stringify(data)).toString("base64url");
  return `${raw}.${mac(raw, secret)}`;
};
async function decode(
  raw: string,
  secret: string,
  ctx: CommandContext,
): Promise<Token> {
  if (/^[A-Za-z0-9_-]{16}$/.test(raw)) {
    const stored = await withTenant(ctx, (tx) =>
      readReference(tx, ctx, raw, "management", referenceScope(secret)),
    );
    const parsed = tokenSchema.safeParse(stored);
    if (!parsed.success || parsed.data.expiresAt < Date.now())
      throw new AppError(ERROR_CODES.PERMISSION_DENIED);
    return parsed.data;
  }
  const [data, sig, extra] = raw.split(".");
  const expected = data ? mac(data, secret) : "";
  if (
    !data ||
    !sig ||
    extra ||
    sig.length !== expected.length ||
    !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
  )
    throw new AppError(ERROR_CODES.NOT_FOUND);
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(data, "base64url").toString());
  } catch {
    throw new AppError(ERROR_CODES.NOT_FOUND);
  }
  const p = tokenSchema.safeParse(value);
  if (!p.success || p.data.expiresAt < Date.now())
    throw new AppError(ERROR_CODES.PERMISSION_DENIED, {
      details: { reason: "selection_expired_query_again" },
    });
  return p.data;
}
interface Booking {
  id: string;
  status: string;
  starts_at: string;
  created_at: string;
  ends_at: string;
  self_reschedule_count: number;
  party_size: number;
}
interface Shop {
  settings: Record<string, unknown>;
  timezone: string;
  cutoff: string;
}
function policy(row: Booking, cfg: OnlineBookingConfig) {
  return {
    status: row.status,
    startsAt: row.starts_at,
    createdAt: row.created_at,
    selfRescheduleCount: row.self_reschedule_count,
    ...cfg,
  };
}

/** These headers are xAI System parameters, not generated tool arguments. */
export function callerFromSystemHeaders(req: Pick<FastifyRequest, "headers">) {
  const raw = req.headers["x-gf-caller-number"],
    started = req.headers["x-gf-call-start-time"];
  const caller =
    typeof raw === "string" && raw.startsWith("+")
      ? phoneE164.safeParse(raw)
      : null;
  const time = typeof started === "string" ? Date.parse(started) : NaN;
  if (
    !caller?.success ||
    !Number.isFinite(time) ||
    time > Date.now() + 60000 ||
    // This is metadata freshness, not a call duration cutoff. Direct SIP calls
    // may continue past the old 15-minute bridge assumption; offer tokens still expire separately.
    Date.now() - time > 24 * 60 * 60000
  )
    throw new AppError(ERROR_CODES.PERMISSION_DENIED, {
      details: { reason: "verified_caller_required" },
    });
  return { caller: caller.data, callStartedAt: new Date(time).toISOString() };
}
export function registerVoiceManagementRoutes(
  app: FastifyInstance,
  authenticate: Auth,
) {
  const routeApp = {
    get: (url: string, handler: any) => {
      app.get(url, handler);
      app.get(url.replace("/appointments", "/appointments-v2"), handler);
    },
    post: (url: string, handler: any) => {
      app.post(url, handler);
      app.post(url.replace("/appointments", "/appointments-v2"), handler);
    },
  };
  async function auth(req: FastifyRequest) {
    const base = await authenticate(req);
    return { ...base, ...callerFromSystemHeaders(req) };
  }
  async function own(a: Awaited<ReturnType<typeof auth>>, selection: Token) {
    if (
      selection.locationId !== a.ctx.locationId ||
      selection.caller !== a.caller ||
      selection.callStartedAt !== a.callStartedAt
    )
      throw new AppError(ERROR_CODES.NOT_FOUND);
    return withTenant(a.ctx, async (tx) => {
      const [row] = await tx<
        Booking[]
      >`select a.id,a.status,a.created_at::text,a.starts_at::text,a.ends_at::text,a.self_reschedule_count,a.party_size
    from appointments a join customers c on c.id=a.customer_id
    where a.id=${selection.appointmentId} and a.location_id=${a.ctx.locationId} and c.phone_e164=${a.caller}
      and a.source in ('web','phone_ai','phone_manual','desk')`;
      if (!row) throw new AppError(ERROR_CODES.NOT_FOUND);
      const [shop] = await tx<
        Shop[]
      >`select settings,timezone,business_day_cutoff::text as cutoff from locations where id=${a.ctx.locationId}`;
      if (!shop) throw new AppError(ERROR_CODES.NOT_FOUND);
      return { row, shop, cfg: readOnlineBooking(shop.settings) };
    });
  }
  const mutationContext = (
    a: Awaited<ReturnType<typeof auth>>,
    s: Token,
  ): CommandContext => ({
    ...a.ctx,
    userId: null,
    membershipId: null,
    permissions: new Set(["appointment.write", "appointment.cancel"]),
    voiceCall: {caller:a.caller,startedAt:a.callStartedAt},
    verifiedBookingCaller: {
      phoneE164: a.caller,
      expectedStartsAt: s.startsAt,
      expectedRescheduleCount: s.count,
    },
  });
  const recordActivity = (a: Awaited<ReturnType<typeof auth>>, appointmentId: string, action: 'lookup'|'reschedule'|'cancel') =>
    dispatch('call.recordAppointmentActivity',{appointmentId,action},{...a.ctx,voiceCall:{caller:a.caller,startedAt:a.callStartedAt}}, {systemOrigin:'voice_tool'});
  const flush = (ctx: CommandContext) => {
    void flushSms(ctx, app.log).catch(() =>
      app.log.warn("Voice SMS flush will retry"),
    );
    void flushEmails(ctx, app.log).catch(() =>
      app.log.warn("Voice email flush will retry"),
    );
  };
  const requestKey = (
    a: Awaited<ReturnType<typeof auth>>,
    s: Token,
    action: string,
  ) =>
    `voice-${action}:${createHash("sha256")
      .update(
        JSON.stringify([
          a.ctx.locationId,
          a.caller,
          a.callStartedAt,
          s.appointmentId,
          s.startsAt,
          s.count,
          s.target ?? null,
        ]),
      )
      .digest("hex")}`;
  const assertFresh = (row: Booking, s: Token) => {
    if (
      Date.parse(row.starts_at) !== Date.parse(s.startsAt) ||
      row.self_reschedule_count !== s.count
    )
      throw new AppError(ERROR_CODES.RESOURCE_CONFLICT, {
        details: { reason: "booking_changed_query_again" },
      });
  };
  const lookupData = async (
    req: FastifyRequest,
    authorized?: Awaited<ReturnType<Auth>>,
  ) => {
    const a = authorized
      ? { ...authorized, ...callerFromSystemHeaders(req) }
      : await auth(req);
    const activityIds: string[] = [];
    const result = await withTenant(a.ctx, async (tx) => {
      const [shop] = await tx<
        Shop[]
      >`select settings,timezone,business_day_cutoff::text as cutoff from locations where id=${a.ctx.locationId}`;
      const cfg = readOnlineBooking(shop!.settings);
      const rows = await tx<
        Booking[]
      >`select a.id,a.status,a.created_at::text,a.starts_at::text,a.ends_at::text,a.self_reschedule_count,a.party_size
    from appointments a join customers c on c.id=a.customer_id where a.location_id=${a.ctx.locationId} and c.phone_e164=${a.caller}
     and a.source in ('web','phone_ai','phone_manual','desk') and a.status='booked' and a.starts_at>now() order by a.starts_at limit 20`;
      const appointments = [];
      for (const row of rows) {
        activityIds.push(row.id);
        const items =
          await tx`select s.name,ai.duration_min,ai.details,ai.addon_ids,
       coalesce((select jsonb_agg(ad.name) from services ad where ad.id=any(ai.addon_ids)), '[]'::jsonb) as addons,case when ai.is_request then sp.display_name else null end as staff_name
     from appointment_items ai left join services s on s.id=ai.service_id left join staff_profiles sp on sp.membership_id=ai.membership_id
     where ai.appointment_id=${row.id} and ai.location_id=${a.ctx.locationId} and ai.status<>'cancelled' order by ai.seq`;
        appointments.push({
          appointmentToken: await (
            req.url.includes("-v2")
              ? (value: Token) =>
                  saveReference(
                    tx,
                    a.ctx,
                    "management",
                    referenceScope(a.secret),
                    value,
                  )
              : (value: Token) => encode(value, a.secret)
          )({
            appointmentId: row.id,
            locationId: a.ctx.locationId,
            caller: a.caller,
            callStartedAt: a.callStartedAt,
            startsAt: row.starts_at,
            count: row.self_reschedule_count,
            expiresAt: Date.now() + 15 * 60000,
            action: "select",
          }),
          startsAt: row.starts_at,
          endsAt: row.ends_at,
          guests: row.party_size,
          services: items.map((i) => ({
            name: pickText(i.name, "en", "Service"),
            minutes: i.duration_min,
            guestIndex: i.details?.publicGuestIndex ?? 0,
            addons: (i.addons as unknown[]).map((name) =>
              pickText(name as any, "en", "Addon"),
            ),
            ...(i.staff_name
              ? { requestedSpecialist: pickText(i.staff_name, "en", "") }
              : {}),
          })),
          actions: guestActions(policy(row, cfg)),
        });
      }
      return {
        ok: true,
        timezone: shop!.timezone,
        appointments,
        supportedActions: [
          "lookup",
          "availability",
          "cancel_entire_appointment",
          "reschedule_entire_appointment",
        ],
      };
    });
    if(!authorized) for(const id of activityIds) await recordActivity(a,id,'lookup');
    return result;
  };
  const lookup = async (req: FastifyRequest, reply: FastifyReply) => {
    parse(z.object({}).strict(), req.query);
    if (req.method === "POST") parse(z.object({}).strict(), req.body ?? {});
    reply.header("Cache-Control", "no-store");
    return lookupData(req);
  };
  routeApp.get("/v1/voice/:number/appointments", lookup);
  routeApp.post("/v1/voice/:number/appointments/lookup", lookup);
  routeApp.post(
    "/v1/voice/:number/appointments/availability",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const a = await auth(req),
        body = parse(selectBody, req.body),
        s = await decode(body.appointmentToken, a.secret, a.ctx);
      if (s.action !== "select") throw new AppError(ERROR_CODES.NOT_FOUND);
      const { row, shop, cfg } = await own(a, s);
      await recordActivity(a,row.id,'reschedule');
      assertFresh(row, s);
      const blocked = guestRescheduleBlockReason(policy(row, cfg));
      if (blocked)
        throw new AppError(ERROR_CODES.PERMISSION_DENIED, {
          details: { reason: blocked },
        });
      const avail = await withTenant(a.ctx, (tx) =>
        loadManagedAvailability(
          tx,
          {
            locationId: a.ctx.locationId,
            timezone: shop.timezone,
            businessDayCutoff: shop.cutoff,
            onlineBooking: cfg,
          },
          row.id,
          body.date,
        ),
      );
      reply.header("Cache-Control", "no-store");
      return {
        ok: true,
        date: avail.date,
        timezone: avail.timezone,
        durationMin: avail.durationMin,
        reason: avail.reason,
        slots: await withTenant(a.ctx, (tx) =>
          Promise.all(
            avail.slots.map(async (slot) => ({
              startsAt: slot.startsAt,
              changeToken: await (
                req.url.includes("-v2")
                  ? (value: Token) =>
                      saveReference(
                        tx,
                        a.ctx,
                        "management",
                        referenceScope(a.secret),
                        value,
                      )
                  : (value: Token) => encode(value, a.secret)
              )({ ...s, action: "reschedule", target: slot.startsAt }),
            })),
          ),
        ),
      };
    },
  );
  routeApp.post(
    "/v1/voice/:number/appointments/cancel",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const a = await auth(req),
        body = parse(cancelBody, req.body),
        s = await decode(body.appointmentToken, a.secret, a.ctx);
      if (s.action !== "select") throw new AppError(ERROR_CODES.NOT_FOUND);
      const { row, cfg } = await own(a, s);
      await recordActivity(a,row.id,'cancel');
      reply.header("Cache-Control", "no-store");
      if (row.status === "cancelled")
        return { ok: true, status: "cancelled", replayed: true };
      assertFresh(row, s);
      const blocked = guestCancelBlockReason(policy(row, cfg));
      if (blocked)
        throw new AppError(ERROR_CODES.PERMISSION_DENIED, {
          details: { reason: blocked },
        });
      const ctx = mutationContext(a, s);
      const out = await dispatch(
        "appointment.cancel",
        {
          appointmentId: row.id,
          reason: "guest_changed_mind",
          keepStaffTurn: false,
        },
        ctx,
        { idempotencyKey: requestKey(a, s, "cancel") },
      );
      flush(ctx);
      return {
        ok: true,
        status: "cancelled",
        replayed: out.replayed,
        notifications: "queued",
      };
    },
  );
  routeApp.post(
    "/v1/voice/:number/appointments/reschedule",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const a = await auth(req),
        body = parse(rescheduleBody, req.body),
        s = await decode(body.changeToken, a.secret, a.ctx);
      if (s.action !== "reschedule" || !s.target)
        throw new AppError(ERROR_CODES.NOT_FOUND);
      const { row } = await own(a, s);
      await recordActivity(a,row.id,'reschedule');
      reply.header("Cache-Control", "no-store");
      const ctx = mutationContext(a, s);
      // The shared handler enforces policy, phone ownership, version and capacity under locks.
      const out = await dispatch(
        "appointment.reschedule",
        { appointmentId: row.id, startsAt: s.target },
        ctx,
        { idempotencyKey: requestKey(a, s, "reschedule") },
      );
      flush(ctx);
      return {
        ok: true,
        status: "booked",
        startsAt: s.target,
        replayed: out.replayed,
        notifications: "queued",
      };
    },
  );
  return lookupData;
}
