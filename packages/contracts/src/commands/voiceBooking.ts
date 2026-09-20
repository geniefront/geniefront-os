import { z } from 'zod';
import { defineCommand, phoneE164, uuid } from '../command.js';

export const VoiceBookingInput = z.object({
  providerCallId:z.string().min(1).max(200).optional(),
  serviceId: uuid, date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  startsAt: z.string().datetime({ offset: true }), membershipId: uuid.nullable().default(null),
  partySize: z.number().int().min(1).max(10).default(1),
  customerName: z.string().trim().min(1).max(120), phoneE164,
  email: z.string().email().max(200).optional(), notes: z.string().max(1000).optional(),
}).strict();
export const SubmitVoiceBooking = defineCommand({
  name: 'voice.submitBooking', system: true, input: VoiceBookingInput,
  output: z.object({ appointmentId: uuid, confirmationCode: z.string(), businessDate: z.string() }),
  permission: 'appointment.write', reversible: false, idempotency: 'required',
  ai: { exposed: false, confirm: 'always', description: 'Create a verified voice appointment' },
});
