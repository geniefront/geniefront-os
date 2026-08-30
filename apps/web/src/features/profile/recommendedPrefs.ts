import type { PersonalNotificationPreferences } from './types';

export const RECOMMENDED_IN_APP_PREFS: PersonalNotificationPreferences['inApp'] = {
  appointmentNew: true,
  appointmentChanged: true,
  appointmentCancelled: true,
  paymentFailed: true,
  customerFeedback: true,
  payoutSettled: true,
  systemSecurity: true,
};

export function withRecommendedInAppPrefs(
  current: PersonalNotificationPreferences,
): PersonalNotificationPreferences {
  return {
    ...current,
    inApp: { ...RECOMMENDED_IN_APP_PREFS },
  };
}

export async function persistRecommendedInAppPrefs(
  current: PersonalNotificationPreferences,
  save: (prefs: PersonalNotificationPreferences) => Promise<unknown>,
): Promise<PersonalNotificationPreferences> {
  const next = withRecommendedInAppPrefs(current);
  await save(next);
  return next;
}
