import { snapshotReader } from "./snapshot";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  AppError,
  ERROR_CODES,
  VoiceBookingInput,
  selectionGuests,
  type CommandContext,
} from "@gf/contracts";
import { withTenant } from "@gf/db";
import { addDays } from "@gf/scheduling";
import { voiceCatalog } from "./catalog";
import { voiceItems, compactTimes, type VoiceItems } from "./selection";
import { saveReference, readReference, referenceScope } from "./references";
import { loadPartyAvailability } from "../public/partyAvailability";
import { dispatch } from "../bus";
import { flushSms } from "../sms/flush";
import { flushEmails } from "../email/flush";
import { callerFromSystemHeaders } from "./manage";

type Auth = (
  req: FastifyRequest,
) => Promise<{ ctx: CommandContext; secret: string }>;
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const d = new Date(`${v}T12:00:00Z`);
    return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v;
  });
const search = z
  .object({
    date: day.optional(),
    serviceId: z.string().uuid().optional(),
    membershipId: z.string().uuid().optional(),
    partySize: z.coerce.number().int().min(1).max(10).default(1),
    itemsJson: z.string().max(12000).optional(),
  })
  .strict();
const submit = z
  .object({
    slotToken: z.string().regex(/^[A-Za-z0-9_-]{16}\.\d+$/),
    time: z.string().regex(/^\d{2}:\d{2}$/),
    customerName: VoiceBookingInput.shape.customerName,
    phoneE164: VoiceBookingInput.shape.phoneE164,
    email: z.string().email().optional(),
    notes: z.string().max(1000).optional(),
  })
  .strict();
const groupSchema = z.object({
  date: day,
  items: voiceItems,
  times: z.array(z.string()),
  startsAtByTime: z.record(z.string()),
  quotedTotalCents: z.number(),
  timezone: z.string(),
});
type Group = z.infer<typeof groupSchema>;
const parse = <S extends z.ZodTypeAny>(
  schema: S,
  value: unknown,
): z.output<S> => {
  const p = schema.safeParse(value);
  if (!p.success)
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: { reason: "invalid_booking_arguments" },
    });
  return p.data;
};
export function registerVoiceV2Routes(
  app: FastifyInstance,
  authenticate: Auth,
  lookup: (req: FastifyRequest) => Promise<unknown>,
) {
  app.get("/v1/voice/:number/context-v2", async (req, reply) => {
    const { ctx, secret } = await authenticate(req);
    const q = parse(search, req.query);
    let selections: VoiceItems | undefined;
    if (q.itemsJson) {
      let raw: unknown;
      try {
        raw = JSON.parse(q.itemsJson);
      } catch {
        throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
          details: { reason: "invalid_items_json" },
        });
      }
      selections = parse(voiceItems, raw);
    } else if (q.serviceId)
      selections = Array.from({ length: q.partySize }, (_, guestIndex) => ({
        guestIndex,
        serviceId: q.serviceId!,
        addonIds: [],
        staffId: q.membershipId ?? null,
      }));
    if ((q.date || q.membershipId || q.partySize !== 1) && !selections)
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
        details: { reason: "service_selection_required" },
      });
    reply.header("Cache-Control", "no-store");
    const result = await withTenant(ctx, async (tx) => {
      const cat = await voiceCatalog(tx, ctx.locationId);
      const reads = snapshotReader(tx);
      const groups: Group[] = [];
      const dates = selections
        ? [q.date ?? cat.context.shop.today]
        : Array.from({ length: 7 }, (_, i) =>
            addDays(cat.context.shop.today, i),
          );
      const choices = selections
        ? [selections]
        : cat.services
            .filter((s) => !s.isAddon)
            .map((s) => [
              {
                guestIndex: 0,
                ...(s.guestCount > 1
                  ? {
                      guestIndices: Array.from(
                        { length: s.guestCount },
                        (_, i) => i,
                      ),
                    }
                  : {}),
                serviceId: s.serviceId,
                addonIds: [],
                staffId: null,
              },
            ]);
      const unavailable: Array<{
        date: string;
        serviceKey?: string;
        reason: string;
      }> = [];
      // A transaction shares one connection; concurrent reads pipeline without a new connection per service.
      const candidates = await Promise.all(
        dates.flatMap((date) =>
          choices.map(async (items) => {
            if (
              cat.holidays?.some(
                (h) =>
                  h === date ||
                  (h &&
                    typeof h === "object" &&
                    (h as any).date === date &&
                    (h as any).closed === true),
              )
            )
              return {
                date,
                items,
                reason: "store_closed",
                times: [],
                startsAtByTime: {},
                quotedTotalCents: 0,
                timezone: cat.shop.timezone,
              };
            if (
              date >
              addDays(
                cat.context.shop.today,
                cat.shop.onlineBooking.maxDaysAhead,
              )
            )
              return {
                date,
                items,
                reason: "date_out_of_window",
                times: [],
                startsAtByTime: {},
                quotedTotalCents: 0,
                timezone: cat.shop.timezone,
              };
            const available = await loadPartyAvailability(reads, cat.shop, {
              date,
              items,
            });
            const format = new Intl.DateTimeFormat("en-GB", {
              timeZone: cat.shop.timezone,
              hour: "2-digit",
              minute: "2-digit",
              hourCycle: "h23",
            });
            const startsAtByTime: Record<string, string> = {};
            for (const p of available.plans) {
              const time = format.format(new Date(p.startsAt));
              if (!startsAtByTime[time]) startsAtByTime[time] = p.startsAt;
            }
            const times = Object.keys(startsAtByTime);
            return {
              date,
              items,
              times,
              startsAtByTime,
              quotedTotalCents: available.items.reduce(
                (n, i) => n + i.priceCents,
                0,
              ),
              timezone: cat.shop.timezone,
              reason: times.length ? null : "no_availability",
            };
          }),
        ),
      );
      for (const g of candidates) {
        if (g.reason)
          unavailable.push({
            date: g.date,
            ...(selections
              ? {}
              : {
                  serviceKey: cat.services.find(
                    (s) => s.serviceId === g.items[0]!.serviceId,
                  )!.serviceKey,
                }),
            reason: g.reason,
          });
        else groups.push(g);
      }
      const id = await saveReference(
        tx,
        ctx,
        "offers",
        referenceScope(secret),
        groups,
      );
      const step = cat.shop.onlineBooking.slotIntervalMinutes ?? 30;
      const offers = groups.map((g, index) => ({
        slotToken: `${id}.${index}`,
        date: g.date,
        ...(selections
          ? {}
          : {
              serviceKey: cat.services.find(
                (s) => s.serviceId === g.items[0]!.serviceId,
              )!.serviceKey,
            }),
        times: compactTimes(g.times, step),
        ...(selections ? { priceCents: g.quotedTotalCents } : {}),
      }));
      return {
        ok: true,
        ...(selections
          ? { timezone: cat.shop.timezone, selection: selections }
          : { ...cat.context }),
        coverage: {
          from: dates[0],
          through: dates[dates.length - 1],
          kind: selections
            ? "exact_selection"
            : "base_services_no_addons_no_staff_preference",
          complete: true,
          generatedAt: new Date().toISOString(),
          expiresInSeconds: 900,
          timeFormat:
            "HH:mm local; start-end/step means inclusive returned times every step minutes",
        },
        offers,
        unavailable,
      };
    });
    let callerAppointments: unknown = undefined;
    if (!selections) {
      try {
        callerFromSystemHeaders(req);
        callerAppointments = await lookup(req);
      } catch (error) {
        if (
          error instanceof AppError &&
          error.code === ERROR_CODES.PERMISSION_DENIED
        )
          callerAppointments = { status: "caller_unverified" };
        else {
          app.log.warn("Voice initial appointment lookup failed");
          callerAppointments = { status: "lookup_failed" };
        }
      }
    }
    const response = {
      ...result,
      ...(callerAppointments ? { callerAppointments } : {}),
    };
    // Never return truncated JSON. Explicit coverage allows a targeted follow-up for large catalogs.
    while (
      Buffer.byteLength(JSON.stringify(response)) > 14500 &&
      response.offers.length
    ) {
      response.offers.pop();
      response.coverage.complete = false;
    }
    if (Buffer.byteLength(JSON.stringify(response)) > 15500)
      throw new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE, {
        details: { reason: "context_too_large" },
      });
    return response;
  });
  app.post("/v1/voice/:number/bookings-v2", async (req, reply) => {
    const { ctx, secret } = await authenticate(req);
    const b = parse(submit, req.body);
    const [id, index] = b.slotToken.split(".");
    const raw = await withTenant(ctx, (tx) =>
      readReference(tx, ctx, id!, "offers", referenceScope(secret)),
    );
    const groups = parse(z.array(groupSchema), raw);
    const g = groups[Number(index)];
    if (!g || !g.times.includes(b.time))
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
        details: { reason: "time_not_offered" },
      });
    const startsAt = g.startsAtByTime[b.time];
    if (!startsAt) throw new AppError(ERROR_CODES.VALIDATION_FAILED);
    const input = {
      serviceId: g.items[0]!.serviceId,
      date: g.date,
      startsAt,
      membershipId: null,
      items: g.items,
      partySize: new Set(g.items.flatMap((i) => [...selectionGuests(i)])).size,
      quotedTotalCents: g.quotedTotalCents,
      customerName: b.customerName,
      phoneE164: b.phoneE164,
      email: b.email,
      notes: b.notes,
    };
    const key =
      "voice-v2-" +
      createHash("sha256")
        .update(
          JSON.stringify([
            ctx.locationId,
            g.date,
            startsAt,
            g.items,
            b.phoneE164,
            b.customerName.toLowerCase(),
          ]),
        )
        .digest("hex");
    // Dispatch checks committed results before rechecking capacity; retries after a timeout cannot duplicate the booking.
    const out = await dispatch("voice.submitBooking", input, ctx, {
      idempotencyKey: key,
      systemOrigin: "xai_voice",
    });
    void flushSms(ctx, app.log).catch(() =>
      app.log.warn("Voice SMS flush will retry"),
    );
    void flushEmails(ctx, app.log).catch(() =>
      app.log.warn("Voice email flush will retry"),
    );
    reply.header("Cache-Control", "no-store");
    return {
      ok: true,
      ...(out.result as object),
      replayed: out.replayed,
      startsAt,
      timezone: g.timezone,
      priceCents: g.quotedTotalCents,
    };
  });
}
