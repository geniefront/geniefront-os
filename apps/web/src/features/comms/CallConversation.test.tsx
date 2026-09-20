import {describe,it,expect,vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {CallConversation} from './CallConversation';
vi.mock('@/LanguageContext',()=>({useLanguage:()=>({t:(key:string)=>key})}));
describe('call conversation',()=>{
 it('labels both participants, timestamps and unassigned legacy text honestly',()=>{
  const html=renderToStaticMarkup(<CallConversation lines={[{role:'assistant',text:'Welcome',startSeconds:0},{role:'user',text:'Book please',startSeconds:12},{role:'system',text:'Legacy transcript'},{role:'tool',text:'private tool data'}]}/>);
  expect(html).toContain('crm.callSpeakerAi');expect(html).toContain('crm.callSpeakerCustomer');expect(html).toContain('00:12');
  expect(html).toContain('bookingTranscript');expect(html).not.toContain('private tool data');
 });
});
