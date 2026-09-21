import { expect, it } from 'vitest';
import { deliveryStatusKey } from './DeliveryHistory';
it('does not present provider acceptance or test capture as delivered', () => {
 expect(deliveryStatusKey({status:'uncertain',delivery_state:null})).toBe('voiceUncertain');
 expect(deliveryStatusKey({status:'sending',delivery_state:null})).toBe('voiceSending');
 expect(deliveryStatusKey({status:'sent',delivery_state:null})).toBe('voiceSent');
 expect(deliveryStatusKey({status:'sent',delivery_state:'delivered'})).toBe('voiceDelivered');
 expect(deliveryStatusKey({status:'captured',delivery_state:null})).toBe('voiceCaptured');
 expect(deliveryStatusKey({status:'sent',delivery_state:'bounced'})).toBe('voiceFailed');
 expect(deliveryStatusKey({status:'sent',delivery_state:'hard_bounce'})).toBe('voiceFailed');
 expect(deliveryStatusKey({status:'sent',delivery_state:'delayed'})).toBe('voicePending');
 expect(deliveryStatusKey({status:'suppressed',delivery_state:null})).toBe('voiceSuppressed');
});
