import {it,expect,vi,afterEach} from 'vitest';
import {transcribeRecording, recentRecordings} from './provider';
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});
it('reconciles all recent recording pages instead of dropping calls after the first page', async () => {
 const mock=vi.fn().mockResolvedValueOnce({ok:true,json:async()=>({data:[{id:'first'}],meta:{total_pages:2}})})
 .mockResolvedValueOnce({ok:true,json:async()=>({data:[{id:'second'}],meta:{total_pages:2}})});
 vi.stubGlobal('fetch',mock);
 expect(await recentRecordings()).toEqual([{id:'first'},{id:'second'}]);
 expect(new URL(mock.mock.calls[1]![0]).searchParams.get('page[number]')).toBe('2');
 expect(new URL(mock.mock.calls[0]![0]).searchParams.has('filter[created_at][gte]')).toBe(true);
});
it('retries broken timing without discarding caller/receptionist channel identity',async()=>{
 vi.stubEnv('XAI_API_KEY','test');
 const mock=vi.fn().mockResolvedValueOnce({ok:true,json:async()=>({text:'Hello',channels:[{index:0,words:[{text:'Hello',start:0,end:30}]}]})})
 .mockResolvedValueOnce({ok:true,json:async()=>({text:'Hello Hi',duration:2,channels:[{index:0,words:[{text:'Hi',start:1,end:2}]},{index:1,words:[{text:'Hello',start:0,end:1}]}]})});
 vi.stubGlobal('fetch',mock);
 const result=await transcribeRecording(Buffer.from('sample'),'audio/mpeg',2);
 expect(mock).toHaveBeenCalledTimes(2);
 expect((mock.mock.calls[0]![1].body as FormData).get('multichannel')).toBe('true');
 expect((mock.mock.calls[1]![1].body as FormData).get('multichannel')).toBe('true');
 expect((mock.mock.calls[1]![1].body as FormData).get('diarize')).toBeNull();
 expect(result.turns.map(t=>[t.role,t.text])).toEqual([['assistant','Hello'],['user','Hi']]);
});
it('does not invent a speaker when a stereo response loses its channels',async()=>{
 vi.stubEnv('XAI_API_KEY','test');
 const mock=vi.fn().mockResolvedValue({ok:true,json:async()=>({text:'Both people',words:[{text:'Both people',start:0,end:2,speaker:0}]})});
 vi.stubGlobal('fetch',mock);
 await expect(transcribeRecording(Buffer.from('sample'),'audio/mpeg',2)).rejects.toThrow('both channels');
 expect(mock).toHaveBeenCalledTimes(2);
});
it('normalizes numeric speaker labels without letting optional labels discard billing analysis',async()=>{
 const {classifyRecording}=await import('./provider');
 vi.stubEnv('XAI_API_KEY','test');
 const mock=vi.fn().mockResolvedValue({ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({summary:'Appointment lookup and cancellation request; no availability.',speakers:[{id:'0',role:'user'},{id:'speaker_7',role:'assistant'},{id:8,role:'assistant'}],segments:[{start:0,end:75,category:'business'}]})}}]})});
 vi.stubGlobal('fetch',mock);
 const result=await classifyRecording({text:'Can I change or cancel my appointment?',words:[{text:'Can',speaker:0,start:0,end:1}]},75);
 expect(result.speakers).toEqual([{id:0,role:'user'}]);expect(result.segments).toEqual([{start:0,end:75,category:'business'}]);
 const prompt=JSON.parse(mock.mock.calls[0]![1].body).messages[0].content;
 expect(prompt).toContain('existing appointment lookup');expect(prompt).toContain('even when unsuccessful');
 expect(prompt).toContain('adult or sexual services');
 expect(prompt).toContain('count as business');
 expect(prompt).toContain('Summarize the requested service and the actual response neutrally');
});
