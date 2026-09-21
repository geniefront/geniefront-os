import { z } from "zod";
import { defineCommand, phoneE164, uuid, cents } from "../command.js";

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
  })
  .strict();
export const SubmitVoiceBooking = defineCommand({
  name: "voice.submitBooking",
  system: true,
  input: VoiceBookingInput,
  output: z.object({
    appointmentId: uuid,
    confirmationCode: z.string(),
    businessDate: z.string(),
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
