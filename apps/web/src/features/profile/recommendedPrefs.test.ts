import { describe, expect, it, vi } from 'vitest';
import type { PersonalNotificationPreferences } from './types';
import {
  persistRecommendedInAppPrefs,
  RECOMMENDED_IN_APP_PREFS,
  withRecommendedInAppPrefs,
} from './recommendedPrefs';

const current: PersonalNotificationPreferences = {
  inApp: {
    appointmentNew: false,
    appointmentChanged: false,
    appointmentCancelled: false,
    paymentFailed: false,
    customerFeedback: false,
    payoutSettled: false,
    systemSecurity: true,
  },
  sms: {
    appointmentNew: false,
    appointmentChanged: false,
    emergencyAlerts: true,
  },
  email: {
    dailyDigest: false,
    financialReports: false,
    securityAlerts: true,
  },
};

describe('recommended notification preferences', () => {
  it('turns on the recommended in-app set without mutating SMS/email locally', () => {
    const next = withRecommendedInAppPrefs(current);
    expect(next.inApp).toEqual(RECOMMENDED_IN_APP_PREFS);
    expect(next.sms).toEqual(current.sms);
    expect(next.email).toEqual(current.email);
  });

  it('persists through the existing save mutation before treating the change as applied', async () => {
    const save = vi.fn().mockResolvedValue({ ok: true });
    const next = await persistRecommendedInAppPrefs(current, save);
    expect(save).toHaveBeenCalledWith({
      ...current,
      inApp: RECOMMENDED_IN_APP_PREFS,
    });
    expect(next.inApp.appointmentNew).toBe(true);
  });

  it('does not return applied prefs when save fails', async () => {
    const save = vi.fn().mockRejectedValue(new Error('offline'));
    await expect(persistRecommendedInAppPrefs(current, save)).rejects.toThrow('offline');
  });
});
