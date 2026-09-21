/**
 * Customer-facing support ticket. Platform operators manage these through
 * /v1/platform — not through this command.
 */

import { z } from 'zod';
import { defineCommand } from '../command.js';

export const supportCategory = z.enum([
  'general', 'onboarding', 'billing', 'sms_10dlc', 'storefront', 'technical', 'other',
]);

export const SubmitSupportRequest = defineCommand({
  name: 'support.submitRequest',
  input: z.object({
    category: supportCategory.default('general'),
    subject: z.string().trim().min(1).max(200),
    description: z.string().trim().min(1).max(8000),
    priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
  }),
  output: z.object({
    requestId: z.string().uuid(),
    status: z.literal('open'),
    createdAt: z.string(),
  }),
  ai: {
    description: 'Submit a support request to GenieFront. Does not change billing or store data.',
    confirm: 'always',
    exposed: false,
  },
  reversible: false,
  idempotency: 'optional',
});

export const ReplySupportRequest = defineCommand({
  name: 'support.replyRequest',
  input: z.object({ requestId: z.string().uuid(), body: z.string().trim().min(1).max(8000).optional(), status: z.enum(['open','resolved']).optional() }).refine(v => Boolean(v.body || v.status)),
  output: z.object({ requestId: z.string().uuid() }),
  permission: 'settings.manage',
  reversible: false, idempotency: 'required',
  ai: { description: 'Reply to, resolve or reopen a support request.', confirm: 'always', exposed: false },
});
export const SUPPORT_COMMANDS = [SubmitSupportRequest, ReplySupportRequest] as const;
