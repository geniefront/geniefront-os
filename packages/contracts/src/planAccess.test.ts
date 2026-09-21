import { describe, expect, it } from 'vitest';
import { canSwitchPlan, planAllowsCommand, planAllowsPath, planAllowsPermission } from './planAccess';
describe('voice booking subscription boundary', () => {
  it('allows only Growth as another plan', () => {
    expect(canSwitchPlan('voice_booking','growth')).toBe(true);
    expect(canSwitchPlan('voice_booking','voice_booking')).toBe(true);
    expect(canSwitchPlan('voice_booking','essential')).toBe(false);
  });
  it('keeps booking and customers while excluding operations modules', () => {
    expect(planAllowsPath('voice_booking','/schedule')).toBe(true);
    expect(planAllowsPath('voice_booking','/customers/123')).toBe(true);
    expect(planAllowsPath('voice_booking','/checkout')).toBe(false);
    expect(planAllowsCommand('voice_booking','ticket.open')).toBe(false);
    expect(planAllowsCommand('voice_booking','voice.submitBooking')).toBe(true);
    expect(planAllowsPermission('voice_booking','customer.view_health_form')).toBe(false);
    expect(planAllowsPermission('growth','customer.view_health_form')).toBe(true);
  });
});

it('allows voice booking staff setup without granting rotation, rooms or payroll', () => {
  for (const command of ['staff.saveProfile', 'staff.saveDirectoryOption', 'staff.reorderDirectoryOptions']) expect(planAllowsCommand('voice_booking', command)).toBe(true);
  for (const command of ['staff.setRotationParticipation', 'resource.save', 'payroll.save']) expect(planAllowsCommand('voice_booking', command)).toBe(false);
});

it('makes voice communications read-only without blocking booking, provisioning or automatic call processing', () => {
  expect(planAllowsPermission('voice_booking', 'comms.send')).toBe(false);
  for (const command of ['sms.sendDirect', 'customer.sendSms', 'email.requestDomain', 'notification.toggleRule', 'notification.saveTemplate', 'settings.apply10dlc', 'settings.saveCheckout', 'settings.saveWebhooks']) {
    expect(planAllowsCommand('voice_booking', command), command).toBe(false);
    expect(planAllowsCommand('growth', command), command).toBe(true);
  }
  for (const command of ['appointment.create', 'appointment.cancel', 'call.completeRecording', 'location.savePhoneLine', 'location.saveBookingPolicy', 'location.saveHours', 'settings.saveVoiceNotifications', 'org.setEmailLocale', 'notification.markRead']) expect(planAllowsCommand('voice_booking', command), command).toBe(true);
});

it('allows personal account commands independently of POS capabilities', () => {
  for (const command of ['user.updateProfile', 'user.saveNotificationPreferences', 'user.revokeSession']) expect(planAllowsCommand('voice_booking', command)).toBe(true);
  expect(planAllowsCommand('voice_booking', 'staff.setPin')).toBe(false);
});
