import { expect, it } from 'vitest';
import { voiceNotificationTargets } from './voiceNotifications';
import { SaveVoiceNotifications, SaveVoiceBookingRules } from './commands/phone';
it('retains existing targets until explicitly configured, and respects disabled channels', () => {
  const fallback = {email:'shop@example.com',phone:'+16676606667'};
  expect(voiceNotificationTargets({}, fallback)).toEqual(fallback);
  expect(voiceNotificationTargets({voice_notifications:{email:null,phone:null}}, fallback)).toEqual({email:null,phone:null});
  expect(voiceNotificationTargets({voice_notifications:{phone:'+447911123456'}}, fallback)).toEqual({...fallback,phone:'+447911123456'});
});
it('validates recipients, allowing channels to be disabled independently', () => {
  expect(SaveVoiceNotifications.input.parse({phone:'6676606667',email:null})).toEqual({phone:'+16676606667',email:null});
  expect(SaveVoiceNotifications.input.safeParse({phone:null,email:'not-an-email'}).success).toBe(false);
});

it("validates actual phone booking window limits", () => {
 expect(SaveVoiceBookingRules.input.safeParse({maxDaysAhead:60,minMinutesAhead:0}).success).toBe(true);
 for (const value of [{maxDaysAhead:0,minMinutesAhead:30},{maxDaysAhead:366,minMinutesAhead:30},{maxDaysAhead:60,minMinutesAhead:-1}]) expect(SaveVoiceBookingRules.input.safeParse(value).success).toBe(false);
});
