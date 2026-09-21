import type { DeskSettings } from '@/features/settings/types';

export type VoiceRoutingMode = 1 | 2 | 3;
export type VoiceChangeTarget = 'routing' | 'store' | 'ai' | 'human' | 'answering' | 'behavior' | 'notifications';
export interface VoiceRoutingSnapshot {
  mode: VoiceRoutingMode | null;
  store: string;
  ai: string;
  human: string;
}

function phoneKey(phone: string) {
  const digits = phone.replace(/\D/g, '');
  return digits.length === 10 ? `1${digits}` : digits;
}

/** Only infer a mode when the saved lines provide enough evidence. */
export function voiceRoutingSnapshot(data: Pick<DeskSettings, 'phone' | 'location' | 'phoneAssistant'>): VoiceRoutingSnapshot {
  const store = data.phone.storefrontE164 || data.location.phone || '';
  const ai = data.phone.aiVoiceE164 || '';
  const human = data.phone.transferTargetE164 || data.phoneAssistant?.forwardPhoneNumber || '';
  const sameLine = Boolean(ai && store && phoneKey(ai) === phoneKey(store));
  const mode = sameLine ? 2 : !ai || !store ? null
    : data.phone.forwardingMode === 'all' ? 1
    : data.phone.forwardingMode === 'busy_no_answer' ? 3 : null;
  return { mode, store, ai, human };
}
