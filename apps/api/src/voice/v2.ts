import { initialVoiceContext } from "./contextCache";
export { initialVoiceContext } from "./contextCache";

import { loadVoiceOffers } from "./offers";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  AppError,
  ERROR_CODES,
  VoiceBookingInput,
  SubmitVoiceBooking,
  selectionGuests,
  type CommandContext,
} from "@gf/contracts";
import { withTenant } from "@gf/db";

import { voiceItems, type VoiceItems } from "./selection";
import { readReference, referenceScope } from "./references";

import { dispatch } from "../bus";
import { flushSms } from "../sms/flush";
import { flushEmails } from "../email/flush";
import { callerFromSystemHeaders } from "./manage";
import {currentVoiceBooking} from './deposit';

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
    time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).optional(),
    serviceId: z.string().uuid().optional(),
    membershipId: z.string().uuid().optional(),
    partySize: z.coerce.number().int().min(1).max(10).optional(),
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
    priceConfirmed: z.boolean().optional(),
    confirmedTotalCents: z.number().int().nonnegative().optional(),
    depositConsent:VoiceBookingInput.shape.depositConsent,
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

const parse = <S extends z.ZodTypeAny>(
  schema: S,
  value: unknown,
): z.output<S> => {
  const p = schema.safeParse(value);
  if (!p.success)
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: {
        reason: "invalid_booking_arguments",
        issues: p.error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })),
        guidance: "Correct the listed fields once. For a shared service use one item with guestIndex:0 and guestIndices:[0,1]. If it still fails, offer staff assistance; do not cycle through parameter guesses.",
      },
    });
  return p.data;
};
export function registerVoiceV2Routes(
  app: FastifyInstance,
  authenticate: Auth,
  lookup: (
    req: FastifyRequest,
    authorized?: Awaited<ReturnType<Auth>>,
  ) => Promise<unknown>,
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
    }
    if (selections && (q.serviceId || q.membershipId || q.partySize !== undefined))
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, { details: {
        reason: "conflicting_selection_fields", guidance: "Use date and itemsJson, or simple serviceId/partySize fields, not both.",
      } });
    if ((q.date || q.time || q.membershipId || q.partySize !== undefined) && !selections && !q.serviceId)
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
        details: { reason: "service_selection_required" },
      });
    reply.header("Cache-Control", "no-store");
    const targeted = Boolean(selections || q.serviceId);
    const callerLookup = !targeted
      ? (async () => {
          try {
            callerFromSystemHeaders(req);
            return await lookup(req, { ctx, secret });
          } catch (error) {
            if (
              error instanceof AppError &&
              error.code === ERROR_CODES.PERMISSION_DENIED
            )
              return { status: "caller_unverified" };
            app.log.warn("Voice initial appointment lookup failed");
            return { status: "lookup_failed" };
          }
        })()
      : Promise.resolve(undefined);
    const [result, callerAppointments] = await Promise.all([
      targeted
        ? loadVoiceOffers(ctx, secret, q, selections)
        : initialVoiceContext(ctx, secret),
      callerLookup,
    ]);
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
    if (b.priceConfirmed !== true || b.confirmedTotalCents === undefined)
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, { details: {
        reason: "price_confirmation_required",
        guidance: "Tell the caller the selected service, duration, local time and full party total. Wait for their agreement, then send priceConfirmed:true and confirmedTotalCents equal to the offer priceCents. A name or phone answer is not price agreement.",
      } });
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
    if (b.confirmedTotalCents !== g.quotedTotalCents)
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, { details: {
        reason: "confirmed_price_mismatch", priceCents: g.quotedTotalCents,
        guidance: "The confirmed total does not match this offer. State the returned full total and obtain the caller's agreement before booking.",
      } });
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
      ...(b.depositConsent?{depositConsent:b.depositConsent}:{}),
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
    const current=await withTenant(ctx,tx=>currentVoiceBooking(tx,ctx,SubmitVoiceBooking.output.parse(out.result).appointmentId));
    void flushSms(ctx, app.log).catch(() =>
      app.log.warn("Voice SMS flush will retry"),
    );
    void flushEmails(ctx, app.log).catch(() =>
      app.log.warn("Voice email flush will retry"),
    );
    reply.header("Cache-Control", "no-store");
    return {
      ok: true,
      ...current,
      replayed: out.replayed,
      startsAt,
      timezone: g.timezone,
      priceCents: g.quotedTotalCents,
      guidance:current.deposit?.additionalPayment?
        'The existing booking remains confirmed. Explain the separate additional deposit request and its current deadline or expired status. Do not say the additional deposit is paid or that the card will be charged automatically. Use email instructions or frontdesk assistance.':current.bookingConfirmed?'The appointment is confirmed.':current.status==='pending_deposit'?
        'The time is held, awaiting the deposit. State the deposit and deadline. Payment confirms the booking; use email instructions or frontdesk assistance. Do not say the booking is confirmed.':
        'The appointment is not confirmed. Explain the returned status and offer frontdesk assistance.',
    };
  });
}
