/**
 * Platform operator mutation inputs.
 *
 * These are NOT registered on the customer command bus. They are invoked
 * only through /v1/platform after server-side operator authorization.
 * Names are recorded in audit_log.command.
 */

import { z } from 'zod';

export const platformTenDlcAction = z.enum([
  'under_review',
  'request_changes',
  'reject',
  'approve_internal',
]);

export const PlatformReview10DlcInput = z.object({
  locationId: z.string().uuid(),
  action: platformTenDlcAction,
  notes: z.string().trim().max(4000).optional(),
});

export const platformSupportStatus = z.enum([
  'open', 'in_progress', 'waiting', 'resolved', 'closed',
]);

export const PlatformUpdateSupportRequestInput = z.object({
  requestId: z.string().uuid(),
  status: platformSupportStatus.optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
  assignedOperatorId: z.string().uuid().nullable().optional(),
});

export const PlatformAddSupportNoteInput = z.object({
  requestId: z.string().uuid(),
  body: z.string().trim().min(1).max(8000),
});

export const platformStorefrontBriefAction = z.enum(['mark_drafted']);

export const PlatformUpdateStorefrontBriefInput = z.object({
  briefId: z.string().uuid(),
  action: platformStorefrontBriefAction,
});

export const platformRevisionStatus = z.enum([
  'submitted', 'in_progress', 'accepted', 'declined',
]);

export const PlatformUpdateStorefrontRevisionInput = z.object({
  revisionId: z.string().uuid(),
  status: platformRevisionStatus,
  response: z.string().trim().max(4000).optional(),
});
