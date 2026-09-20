import { expect, it } from 'vitest';
import { SettingsSavePhoneAssistant } from './commands/phone';
import { SaveLocationProfile, SaveStaffProfile, Apply10Dlc } from './commands/setup';
import { SubmitForm } from './commands/kiosk';
it('normalizes store, staff, transfer and registration numbers with the same rules', () => {
  expect(SaveLocationProfile.input.parse({phone:'6676606667'}).phone).toBe('+16676606667');
  expect(SaveStaffProfile.input.parse({phone:'(667) 660-6667'}).phone).toBe('+16676606667');
  expect(SettingsSavePhoneAssistant.input.parse({forwardPhoneNumber:'6676606667'}).forwardPhoneNumber).toBe('+16676606667');
  expect(Apply10Dlc.input.shape.repPhone.parse('+44 7911 123456')).toBe('+447911123456');
  expect(SettingsSavePhoneAssistant.input.safeParse({forwardPhoneNumber:'call6676606667'}).success).toBe(false);
});
it('normalizes known health-form contact fields server-side and rejects invalid emergency contacts', () => {
 const input={templateId:'11111111-1111-4111-8111-111111111111',signerName:'Guest',answers:{clientInfo:{phone:'6676606667',emergencyPhone:'+44 7911 123456'}}};
 expect(SubmitForm.input.parse(input).answers.clientInfo).toEqual({phone:'+16676606667',emergencyPhone:'+447911123456'});
 expect(SubmitForm.input.safeParse({...input,answers:{clientInfo:{phone:'123'}}}).success).toBe(false);
});
