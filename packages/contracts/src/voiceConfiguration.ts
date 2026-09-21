import { z } from 'zod';
import { phoneE164 } from './command.js';
import { voiceNotificationTargets } from './voiceNotifications.js';

export const voiceResponseSettingsSchema = z.object({
  greetingPrompt: z.string().trim().max(4000),
  voiceTone: z.enum(['warm', 'professional', 'concise']).nullable(),
  autoBookEnabled: z.boolean().nullable(),
  afterHoursVoicemail: z.boolean().nullable(),
}).strict();
export const voiceConfigurationSchema = z.object({
  phoneAssistant: voiceResponseSettingsSchema,
  voiceNotifications: z.object({
    email: z.string().trim().email().max(320).nullable(),
    phone: phoneE164.nullable(),
  }).strict(),
}).strict();
export const platformSaveVoiceConfigurationSchema = voiceConfigurationSchema.extend({
  expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
});
export type VoiceConfiguration = z.infer<typeof voiceConfigurationSchema>;
export type VoiceConfigurationPanel = VoiceConfiguration & { revision: string };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Shared by Ops and the customer desk. Missing switches are unknown, not enabled. */
export function readVoiceConfiguration(settings: unknown, fallback: { email: string | null; phone: string | null }): VoiceConfiguration {
  const root = record(settings);
  const assistant = record(root.phone_assistant ?? root.phoneAssistant);
  const tone = assistant.voiceTone ?? assistant.tone;
  return {
    phoneAssistant: {
      greetingPrompt: typeof assistant.greetingPrompt === 'string' ? assistant.greetingPrompt : '',
      voiceTone: tone === 'warm' || tone === 'professional' || tone === 'concise' ? tone : null,
      autoBookEnabled: typeof assistant.autoBookEnabled === 'boolean' ? assistant.autoBookEnabled : null,
      afterHoursVoicemail: typeof assistant.afterHoursVoicemail === 'boolean' ? assistant.afterHoursVoicemail : null,
    },
    voiceNotifications: voiceNotificationTargets(settings, fallback),
  };
}

/** Preserve other location settings and legacy assistant fields (including transfer numbers). */
export function mergeVoiceConfiguration(settings: unknown, config: VoiceConfiguration): Record<string, unknown> {
  const root = record(settings);
  const assistant = { ...record(root.phone_assistant ?? root.phoneAssistant), ...config.phoneAssistant, tone: config.phoneAssistant.voiceTone };
  return { ...root, phone_assistant: assistant, phoneAssistant: assistant, voice_notifications: config.voiceNotifications };
}
