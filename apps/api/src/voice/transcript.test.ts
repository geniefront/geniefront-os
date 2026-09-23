import { describe,it,expect } from 'vitest';
import {recordingTurns,labelDiarizedTurns} from './transcript';
describe('recording conversation',()=>{
 it('orders dual channels by time and preserves role changes and timestamps',()=>{
  const turns=recordingTurns({text:'Hello Hi Welcome back', channels:[
   {index:0,words:[{text:'Hi',start:2,end:2.5}]},
   {index:1,words:[{text:'Hello',start:0,end:1},{text:'Welcome',start:3,end:3.5},{text:'back.',start:3.6,end:4}]},
  ]});
  expect(turns.map(t=>[t.role,t.text,t.startSeconds])).toEqual([['assistant','Hello',0],['user','Hi',2],['assistant','Welcome back.',3]]);
 });
 it('does not invent identities for mono speaker IDs or unlabelled text',()=>{
  expect(recordingTurns({text:'hello',words:[{text:'hello',start:0,end:1,speaker:0}]})).toEqual([{role:'system',text:'hello',startSeconds:0,endSeconds:1,speaker:0}]);
  expect(recordingTurns({text:'A whole recording.'})).toEqual([{role:'system',text:'A whole recording.'}]);
 });
 it('rejects invalid timestamps and keeps Chinese spacing natural',()=>{
  expect(recordingTurns({text:'您好。',channels:[{index:0,words:[]},{index:1,words:[{text:'您',start:0,end:1},{text:'好',start:1,end:2},{text:'。',start:2,end:3},{text:'bad',start:-1,end:0}]}]})[0]?.text).toBe('您好。');
 });
});

it('maps only known diarized speakers, preserving words and unknown identities',()=>{
 const turns=recordingTurns({text:'Hello Yes',words:[{text:'Hello',start:0,end:1,speaker:7},{text:'Yes',start:2,end:3,speaker:4}]});
 expect(labelDiarizedTurns(turns,[{id:7,role:'assistant'}]).map(t=>[t.role,t.text])).toEqual([['assistant','Hello'],['system','Yes']]);
});

it('maps direct SIP incoming recording channel 0 to receptionist and channel 1 to customer',()=>{
 expect(recordingTurns({text:'Reception Customer',channels:[
 {index:0,words:[{text:'Reception',start:0,end:1}]},
 {index:1,words:[{text:'Customer',start:2,end:3}]}]},1).map(t=>[t.role,t.text])).toEqual([['assistant','Reception'],['user','Customer']]);
});
