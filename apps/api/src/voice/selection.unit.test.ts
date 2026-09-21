import { describe, it, expect } from 'vitest';
import { voiceItems, simpleVoiceItems, assertSharedVoiceSelection } from './selection';
const serviceId='11111111-1111-4111-8111-111111111111';
const service={serviceId,guestCount:2};
describe('shared voice services',()=>{
 it('accepts the actual failed call shape with covered guests and no redundant anchor',()=>{
  expect(voiceItems.parse([{serviceId,guestIndices:[0,1]}])).toEqual([{serviceId,guestIndex:0,guestIndices:[0,1],addonIds:[],staffId:null}]);
 });
 it('does not guess a missing guest or accept a conflicting anchor',()=>{
  expect(voiceItems.safeParse([{serviceId}]).success).toBe(false);
  expect(voiceItems.parse([{serviceId,guestIndex:1,guestIndices:[0,1]}])[0]!.guestIndex).toBe(1);
 });
 it('groups a simple couples selection once per pair, not once per person',()=>{
  expect(simpleVoiceItems(service,2)).toHaveLength(1);
  expect(simpleVoiceItems(service)).toHaveLength(1);
  expect(simpleVoiceItems(service,4).map(i=>i.guestIndices)).toEqual([[0,1],[2,3]]);
  expect(()=>simpleVoiceItems(service,3)).toThrow();
 });
 it('rejects the successful-but-doubled call payload even when anchors/addons differ',()=>{
  const items=voiceItems.parse([{serviceId,guestIndex:0,guestIndices:[0,1]}, {serviceId,guestIndex:1,guestIndices:[0,1]}]);
  expect(()=>assertSharedVoiceSelection(items,[service])).toThrowError(expect.objectContaining({details:expect.objectContaining({reason:'duplicate_shared_service'})}));
 });
 it('allows two separate couples and ordinary consecutive single-person services',()=>{
  expect(()=>assertSharedVoiceSelection(simpleVoiceItems(service,4),[service])).not.toThrow();
  const one={serviceId,guestCount:1};
  expect(()=>assertSharedVoiceSelection([...simpleVoiceItems(one),...simpleVoiceItems(one)],[one])).not.toThrow();
 });
});
