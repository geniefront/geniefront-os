import { describe, expect, it } from 'vitest';
import { QueueDeviceCommand, SaveFormTemplate } from './commands/kiosk';

const base = {
  key: 'health_intake',
  title: { en: 'Health intake' },
  requiresSignature: true,
  validDays: 365,
  serviceIds: [],
};

describe('health-form template contract', () => {
  it('accepts a type-safe custom question set', () => {
    const parsed = SaveFormTemplate.input.safeParse({ ...base, questions: [
      { id: 'health_flag', type: 'bool', label: { en: 'Any restrictions?' }, required: true, sync: 'health_flag' },
      { id: 'avoid_areas', type: 'multi', label: { en: 'Areas to avoid' }, required: false, sync: 'avoid_areas', options: [{ value: 'neck', label: { en: 'Neck' } }] },
    ] });
    expect(parsed.success).toBe(true);
  });

  it('rejects duplicate question ids and ambiguous option values', () => {
    const parsed = SaveFormTemplate.input.safeParse({ ...base, questions: [
      { id: 'same', type: 'bool', label: { en: 'First' } },
      { id: 'same', type: 'choice', label: { en: 'Second' }, options: [
        { value: 'yes', label: { en: 'Yes' } }, { value: 'yes', label: { en: 'Also yes' } },
      ] },
    ] });
    expect(parsed.success).toBe(false);
  });

  it('rejects profile sync targets on incompatible question types', () => {
    expect(SaveFormTemplate.input.safeParse({ ...base, questions: [
      { id: 'notes', type: 'text', label: { en: 'Notes' }, sync: 'health_flag' },
    ] }).success).toBe(false);
    expect(SaveFormTemplate.input.safeParse({ ...base, questions: [
      { id: 'avoid', type: 'bool', label: { en: 'Avoid?' }, sync: 'avoid_areas' },
    ] }).success).toBe(false);
  });
});

describe('device command contract', () => {
  it('only accepts supported terminal commands', () => {
    const deviceId = '00000000-0000-4000-8000-000000000001';
    expect(QueueDeviceCommand.input.safeParse({ deviceId, kind: 'wake' }).success).toBe(true);
    expect(QueueDeviceCommand.input.safeParse({ deviceId, kind: 'reset_home' }).success).toBe(true);
    expect(QueueDeviceCommand.input.safeParse({ deviceId, kind: 'factory_reset' }).success).toBe(false);
  });
});
