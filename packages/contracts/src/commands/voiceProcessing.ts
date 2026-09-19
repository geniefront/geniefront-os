import { z } from 'zod';
import { defineCommand, uuid } from '../command.js';
const system = { system: true, permission: 'call.draft' as const, reversible: false,
  idempotency: 'optional' as const, ai: { exposed: false, confirm: 'never' as const, description: 'Internal voice processing' } };
export const VoiceAnalysis = z.object({
  summary: z.string().max(1000),
  segments: z.array(z.object({ start: z.number().nonnegative(), end: z.number().nonnegative(),
    category: z.enum(['business', 'spam', 'sales', 'silence', 'off_topic', 'system_failure']) }).strict()).max(200),
}).strict();
export const QueueVoiceRecording = defineCommand({ ...system, name: 'call.queueRecording',
  input: z.object({ providerCallId: z.string().min(1).max(120), recordingId: z.string().min(1).max(120),
    to: z.string().max(24), from: z.string().max(24).optional(),
    startedAt: z.string().datetime({ offset: true }).optional(), durationSeconds: z.number().int().min(0).max(86400) }),
  output: z.object({ queued: z.boolean() }),
});
export const ClaimVoiceJob = defineCommand({ ...system, name: 'call.claimRecording', input: z.object({}),
  output: z.object({ job: z.object({ id: uuid, leaseId: uuid, providerCallId: z.string(), recordingId: z.string(),
    payload: z.record(z.unknown()), attempts: z.number() }).nullable() }),
});
export const CompleteVoiceJob = defineCommand({ ...system, name: 'call.completeRecording',
  input: z.object({ jobId: uuid, leaseId: uuid, durationSeconds: z.number().int().min(0).max(86400),
    transcript: z.string().max(100000), analysis: VoiceAnalysis, recordingUrl: z.string().url().max(2000) }),
  output: z.object({ completed: z.boolean(), billableSeconds: z.number().optional() }),
});
export const FailVoiceJob = defineCommand({ ...system, name: 'call.failRecording',
  input: z.object({ jobId: uuid, leaseId: uuid, reason: z.string().max(200) }),
  output: z.object({ saved: z.boolean() }),
});
export const VOICE_PROCESSING_COMMANDS = [QueueVoiceRecording, ClaimVoiceJob, CompleteVoiceJob, FailVoiceJob] as const;
