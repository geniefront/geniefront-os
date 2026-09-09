import { describe, expect, it } from 'vitest';
import {
  SETUP_STEP_IDS, setupReadiness, setupMissingCode,
} from './setupReadiness';

describe('setup readiness contract', () => {
  it('freezes the seven setup domains in display order', () => {
    expect(SETUP_STEP_IDS).toEqual([
      'store', 'directory', 'rooms', 'catalog', 'team', 'features', 'launch',
    ]);
  });

  it('accepts structured repair targets and rejects unknown missing codes', () => {
    expect(setupReadiness.parse({
      locationId: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
      status: 'setup',
      canLaunch: false,
      steps: SETUP_STEP_IDS.map((id) => ({ id, complete: false })),
      missing: [{ code: 'active_room', stepId: 'rooms' }],
      warnings: [{ code: 'directory_recommended', stepId: 'directory' }],
      aiVoice: {
        intent: null, lineBound: false, assistantConfigured: false,
        toolTokenSet: false, ready: false, effectiveAiAnswer: false,
        state: 'unconfigured',
      },
      features: { healthFormsEnabled: null, confirmedAt: null },
    }).missing[0]).toEqual({ code: 'active_room', stepId: 'rooms' });
    expect(setupMissingCode.safeParse('phone_line').success).toBe(false);
  });
});
