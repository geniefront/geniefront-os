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
