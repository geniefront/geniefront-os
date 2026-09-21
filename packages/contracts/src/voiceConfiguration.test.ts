import { describe, expect, it } from 'vitest';
import { mergeVoiceConfiguration, readVoiceConfiguration, voiceConfigurationSchema } from './voiceConfiguration';
const fallback = { email: 'shop@example.com', phone: '+16676606667' };
describe('operator-maintained voice configuration', () => {
  it('does not invent greeting, voice style or enabled switches when missing', () => {
    expect(readVoiceConfiguration({}, fallback)).toEqual({ phoneAssistant: { greetingPrompt: '', voiceTone: null, autoBookEnabled: null, afterHoursVoicemail: null }, voiceNotifications: fallback });
  });
  it('preserves explicit false and disabled notification channels', () => {
    expect(readVoiceConfiguration({ phone_assistant: { autoBookEnabled: false, afterHoursVoicemail: false, tone: 'concise' }, voice_notifications: { email: null, phone: null } }, fallback)).toMatchObject({ phoneAssistant: { autoBookEnabled: false, afterHoursVoicemail: false, voiceTone: 'concise' }, voiceNotifications: { email: null, phone: null } });
  });
  it('preserves unrelated settings and legacy transfer fields on save', () => {
    const config = readVoiceConfiguration({ phoneAssistant: { greetingPrompt: 'Hello', tone: 'warm' } }, fallback);
    const merged = mergeVoiceConfiguration({ checkout: { tax: 4 }, phoneAssistant: { forwardPhoneNumber: '+12125550123' } }, config);
    expect(merged.checkout).toEqual({ tax: 4 });
    expect(merged.phone_assistant).toMatchObject({ greetingPrompt: 'Hello', forwardPhoneNumber: '+12125550123' });
    expect(readVoiceConfiguration(merged, { email: null, phone: null })).toEqual(config);
  });
  it('validates email, phone and voice style before persisting', () => {
    const config = readVoiceConfiguration({}, fallback);
    expect(voiceConfigurationSchema.safeParse(config).success).toBe(true);
    expect(voiceConfigurationSchema.safeParse({ ...config, voiceNotifications: { ...fallback, email: 'invalid' } }).success).toBe(false);
    expect(voiceConfigurationSchema.safeParse({ ...config, voiceNotifications: { ...fallback, phone: 'invalid' } }).success).toBe(false);
    expect(voiceConfigurationSchema.safeParse({ ...config, phoneAssistant: { ...config.phoneAssistant, voiceTone: 'unrecognized' } }).success).toBe(false);
  });
});
