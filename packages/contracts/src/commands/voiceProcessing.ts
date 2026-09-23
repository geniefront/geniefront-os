import { z } from 'zod';
import { defineCommand, uuid } from '../command.js';
const system = { system: true, permission: 'call.draft' as const, reversible: false,
  idempotency: 'optional' as const, ai: { exposed: false, confirm: 'never' as const, description: 'Internal voice processing' } };
export const VoiceAnalysis = z.object({
  summary: z.string().max(1000),
  speakers: z.array(z.object({ id: z.number().int().nonnegative(), role: z.enum(['user','assistant','unknown']) }).strict()).max(20).optional(),
  segments: z.array(z.object({ start: z.number().nonnegative(), end: z.number().nonnegative(),
    category: z.enum(['business', 'spam', 'sales', 'silence', 'off_topic', 'system_failure']) }).strict()).max(200),
}).strict();
export const QueueVoiceRecording = defineCommand({ ...system, name: 'call.queueRecording',
  input: z.object({ providerCallId: z.string().min(1).max(120), recordingId: z.string().min(1).max(120),
    to: z.string().max(24), from: z.string().max(24).optional(),
    startedAt: z.string().datetime({ offset: true }).optional(), durationSeconds: z.number().int().min(0).max(86400),
    /** Provider-verified boundary; never supplied by a model or public caller. */
    aiDurationSeconds: z.number().int().min(0).max(86400).optional(),
    callDurationSeconds: z.number().int().min(0).max(86400).optional(),
    suppressNotification: z.boolean().optional(),
    callerChannel: z.union([z.literal(0), z.literal(1)]).optional(),
    outcome: z.enum(['completed','transferred_to_human']).optional() }),
  output: z.object({ queued: z.boolean() }),
});
export const ClaimVoiceJob = defineCommand({ ...system, name: 'call.claimRecording', input: z.object({}),
  output: z.object({ job: z.object({ id: uuid, leaseId: uuid, providerCallId: z.string(), recordingId: z.string(),
    payload: z.record(z.unknown()), attempts: z.number() }).nullable() }),
});
export const CompleteVoiceJob = defineCommand({ ...system, name: 'call.completeRecording',
  input: z.object({ jobId: uuid, leaseId: uuid, durationSeconds: z.number().int().min(0).max(86400),
    transcript: z.string().max(100000), turns: z.array(z.object({ role: z.enum(['user','assistant','system']), text: z.string().max(4000), startSeconds: z.number().nonnegative().optional(), endSeconds: z.number().nonnegative().optional(), speaker: z.number().int().nonnegative().optional() }).strict()).max(10000).optional(), analysis: VoiceAnalysis, recordingUrl: z.string().url().max(2000) }),
  output: z.object({ completed: z.boolean(), billableSeconds: z.number().optional() }),
});
export const FailVoiceJob = defineCommand({ ...system, name: 'call.failRecording',
  input: z.object({ jobId: uuid, leaseId: uuid, reason: z.string().max(200) }),
  output: z.object({ saved: z.boolean() }),
});
export const RecordVoiceAppointmentActivity = defineCommand({ ...system, name: 'call.recordAppointmentActivity',
 input: z.object({ appointmentId: uuid, action: z.enum(['lookup','reschedule','cancel']) }).strict(),
 output: z.object({ saved: z.boolean() }),
});
export const VOICE_PROCESSING_COMMANDS = [RecordVoiceAppointmentActivity, QueueVoiceRecording, ClaimVoiceJob, CompleteVoiceJob, FailVoiceJob] as const;
