import { describe, expect, it } from 'vitest';
import { voiceRoutingSnapshot } from './voiceRouting';
import type { DeskSettings } from '@/features/settings/types';
const snapshot = (store: string, ai: string, forwardingMode: string | null) => voiceRoutingSnapshot({ location: { phone: store }, phone: { storefrontE164: store, aiVoiceE164: ai, transferTargetE164: '+16676606667', forwardingMode } } as DeskSettings);
describe('saved routing mode', () => {
  it('recognizes the current direct AI shop line across phone formats', () => {
    expect(snapshot('757 731 7358', '+17577317358', 'busy_no_answer')).toEqual({ mode: 2, store: '757 731 7358', ai: '+17577317358', human: '+16676606667' });
  });
  it('distinguishes forwarding all calls from forwarding busy/unanswered calls', () => {
    expect(snapshot('+12125550111', '+17577317358', 'all').mode).toBe(1);
    expect(snapshot('+12125550111', '+17577317358', 'busy_no_answer').mode).toBe(3);
  });
  it('does not invent a current mode for incomplete or unknown settings', () => {
    expect(snapshot('', '+17577317358', 'all').mode).toBeNull();
    expect(snapshot('+12125550111', '', 'all').mode).toBeNull();
    expect(snapshot('+12125550111', '+17577317358', null).mode).toBeNull();
  });
});
