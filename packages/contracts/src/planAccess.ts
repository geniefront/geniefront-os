/** Shared capability rules. Subscription price does not determine features. */
const VOICE_PATHS = ['/schedule', '/customers', '/calls', '/messages', '/communication-logs',
  '/settings', '/profile', '/support', '/notifications'];
export function planAllowsPath(plan: string | null | undefined, path: string): boolean {
  return plan !== 'voice_booking' || VOICE_PATHS.some(p => path === p || path.startsWith(`${p}/`));
}
export function planAllowsPermission(plan: string | null | undefined, permission: string): boolean {
  if (plan !== 'voice_booking') return true;
  if (permission === 'customer.view_health_form' || permission === 'comms.send') return false;
  return ['appointment.', 'customer.', 'billing.', 'call.', 'comms.', 'support.', 'profile.', 'notification.']
    .some(p => permission.startsWith(p)) || ['settings.manage', 'staff.manage', 'catalog.manage', 'schedule.read'].includes(permission);
}
export function planAllowsCommand(plan: string | null | undefined, command: string): boolean {
  if (plan !== 'voice_booking') return true;
  if (command.startsWith('sms.') || command.startsWith('email.') || ['customer.sendSms', 'notification.saveTemplate', 'notification.toggleRule', 'settings.apply10dlc', 'settings.saveWebhooks', 'location.addWebOrigin', 'location.removeWebOrigin', 'location.saveAiChangePolicy'].includes(command)) return false;
  if (['settings.saveCheckout', 'location.saveCheckoutSettings', 'location.saveIntakeWaiver'].includes(command)) return false;
  return ['appointment.', 'voice.', 'customer.', 'billing.', 'call.', 'profile.', 'support.', 'catalog.',
    'notification.'].some(p => command.startsWith(p))
    || ['location.savePhoneLine', 'location.saveProfile', 'location.saveHours', 'location.saveOnlineBooking', 'location.saveOffHours', 'location.finishSetup', 'location.applyGoogle', 'location.saveBookingPolicy', 'location.requestAiVoice', 'location.savePhoneAssistantLine', 'setup.claimLocation', 'settings.saveSetupFeatures', 'settings.savePhoneAssistant', 'settings.saveVoiceNotifications', 'settings.saveVoiceBookingRules', 'staff.saveBookingSchedule', 'settings.saveVoiceCapacity', 'org.setEmailLocale', 'staff.saveProfile', 'staff.add', 'staff.setEmployment', 'staff.setLocale', 'staff.saveDirectoryOption', 'staff.reorderDirectoryOptions'].includes(command);
}
export function canSwitchPlan(from: string, to: string): boolean {
  return from !== 'voice_booking' || to === 'voice_booking' || to === 'growth';
}
