import { z } from 'zod';
import { defineCommand, uuid } from '../command.js';

export const BookingPolicyInput = z.object({
  mode: z.enum(['staff', 'location']),
  autoAssign: z.boolean().optional(),
  baseCapacity: z.number().int().min(1).max(100),
  bufferEnabled: z.boolean().default(false),
  bufferExtra: z.number().int().min(1).max(10).default(1),
  requestBufferEnabled: z.boolean().default(false),
  requestBufferExtra: z.number().int().min(1).max(5).default(1),
}).strict();

export const SaveBookingPolicy = defineCommand({
  name: 'location.saveBookingPolicy',
  input: BookingPolicyInput,
  output: z.object({ locationId: uuid }),
  permission: 'settings.manage',
  reversible: false,
  idempotency: 'optional',
  ai: { exposed: false, description: 'Configure booking capacity and opt-in buffers', confirm: 'always' },
});
