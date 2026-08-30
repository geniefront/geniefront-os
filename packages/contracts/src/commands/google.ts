import { z } from 'zod';
import { defineCommand, phoneE164, uuid } from '../command.js';

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export const ApplyGoogleBusiness = defineCommand({
  name: 'location.applyGoogle',
  input: z.object({
    googlePlaceId: z.string().min(1).max(255),
    name: z.string().min(1).max(200).optional(),
    phone: phoneE164.optional(),
    address: z.object({
      line1: z.string().max(200).nullable(), line2: z.string().max(200).nullable(),
      city: z.string().max(120).nullable(), state: z.string().max(40).nullable(),
      zip: z.string().max(20).nullable(), country: z.string().max(8).nullable(),
    }).optional(),
    businessHours: z.record(
      z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']),
      z.object({ open: hhmm, close: hhmm }).nullable(),
    ).optional(),
    ratingBp: z.number().int().min(0).max(50000).nullable().optional(),
    reviewCount: z.number().int().min(0).nullable().optional(),
  }),
  output: z.object({ locationId: uuid, applied: z.array(z.string()) }),
  permission: 'settings.manage',
  ai: {
    description: '把老板从 Google 搜索结果中确认勾选的公开门店资料写入本店。',
    confirm: 'always',
  },
  reversible: true,
  idempotency: 'optional',
});

export const GOOGLE_COMMANDS = [ApplyGoogleBusiness] as const;
