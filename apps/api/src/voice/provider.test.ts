import {it,expect,vi,afterEach} from 'vitest';
import {transcribeRecording} from './provider';
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});
it('retries broken multichannel word timing once using diarization',async()=>{
 vi.stubEnv('XAI_API_KEY','test');
 const mock=vi.fn().mockResolvedValueOnce({ok:true,json:async()=>({text:'Hello',channels:[{index:0,words:[{text:'Hello',start:0,end:30}]}]})})
 .mockResolvedValueOnce({ok:true,json:async()=>({text:'Hello',duration:1,words:[{text:'Hello',start:0,end:1,speaker:9}]})});
 vi.stubGlobal('fetch',mock);
 const result=await transcribeRecording(Buffer.from('sample'),'audio/mpeg',2);
 expect(mock).toHaveBeenCalledTimes(2);
 expect((mock.mock.calls[0]![1].body as FormData).get('multichannel')).toBe('true');
 expect((mock.mock.calls[1]![1].body as FormData).get('diarize')).toBe('true');
 expect(result.turns[0]).toMatchObject({role:'system',speaker:9,text:'Hello'});
});
