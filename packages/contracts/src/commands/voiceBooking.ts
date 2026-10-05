import { z } from "zod";
import { defineCommand, phoneE164, uuid, cents } from "../command.js";
import {depositConsent} from './commerce.js';

export const VoiceDepositQuote=z.object({required:z.literal(true),policyVersion:z.string(),amountCents:cents.positive(),
 serviceTotalCents:cents.nonnegative(),currency:z.string(),cancelCutoffHours:z.number().nonnegative(),retainAfterCutoff:z.boolean(),
 policyNotice:z.string(),holdMinutes:z.literal(15)});

export const VoiceBookingItems = z
  .array(
    z
      .object({
        guestIndex: z.number().int().min(0).max(9),
        guestIndices: z
          .array(z.number().int().min(0).max(9))
          .min(1)
          .max(10)
          .optional(),
        serviceId: uuid,
        addonIds: z.array(uuid).max(10).default([]),
        staffId: uuid.nullable().default(null),
      })
      .strict(),
  )
  .min(1)
  .max(20);

export const VoiceBookingInput = z
  .object({
    providerCallId: z.string().min(1).max(200).optional(),
    serviceId: uuid,
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    startsAt: z.string().datetime({ offset: true }),
    membershipId: uuid.nullable().default(null),
    partySize: z.number().int().min(1).max(10).default(1),
    items: VoiceBookingItems.optional(),
    quotedTotalCents: cents.nonnegative().optional(),
    customerName: z.string().trim().min(1).max(120),
    phoneE164,
    email: z.string().email().max(200).optional(),
    notes: z.string().max(1000).optional(),
    depositConsent:depositConsent.optional(),
  })
  .strict();
export const SubmitVoiceBooking = defineCommand({
  name: "voice.submitBooking",
  system: true,
  input: VoiceBookingInput,
  output: z.object({
    appointmentId: uuid,
    businessDate: z.string(),
    status:z.enum(['confirmed','pending_deposit','expired','cancelled','review']),
    bookingConfirmed:z.boolean(),
    deposit:z.object({holdId:uuid,amountCents:cents.nonnegative(),currency:z.string(),expiresAt:z.string(),
      additionalPayment:z.object({amountCents:cents.positive(),expiresAt:z.string(),state:z.enum(['open','expired']),paymentAction:z.enum(['email_link','frontdesk','none'])}).optional(),
      paymentAction:z.enum(['email_link','frontdesk','none']),emailDelivery:z.enum(['queued','sent','captured','failed','unavailable'])}).optional(),
  }),
  permission: "appointment.write",
  reversible: false,
  idempotency: "required",
  ai: {
    exposed: false,
    confirm: "always",
    description: "Create a verified voice appointment",
  },
});
