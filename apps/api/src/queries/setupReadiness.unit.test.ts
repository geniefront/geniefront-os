import { describe, expect, it, vi } from 'vitest';
vi.mock('./aiVoiceReadiness', () => ({ loadAiVoiceReadiness: async () => ({ state: 'unconfigured', intent: false }) }));
import { loadSetupReadiness } from './setupReadiness';

describe('voice booking setup requirements', () => {
  const row = { id: 'store', status: 'setup', voice_booking: true, profile_confirmed: true, hours_configured: true,
    active_rooms: 0, active_services: 1, bookable_staff: 0, directory_entries: 0, features_confirmed: false, features_confirmed_at: null, health_forms_enabled: false };
  it('requires a bookable employee but does not require rooms', async () => {
    const result = await loadSetupReadiness((async () => [row]) as any, { locationId: 'store' } as any);
    expect(result.canLaunch).toBe(false);
    expect(result.missing).toEqual([{ code: 'bookable_staff', stepId: 'team' }]);
    expect(result.steps.find(s => s.id === 'team')?.complete).toBe(false);
  });
  it('allows launch with services and staff even without optional directory settings', async () => {
    const result = await loadSetupReadiness((async () => [{ ...row, bookable_staff: 1 }]) as any, { locationId: 'store' } as any);
    expect(result.canLaunch).toBe(true);
    expect(result.missing).toEqual([]);
  });
});
