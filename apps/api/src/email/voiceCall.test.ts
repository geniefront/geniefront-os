import {it,expect} from 'vitest';
import {renderVoiceCallEmail} from './voiceCall';
it('renders a branded scannable call email with escaped speaker turns and authenticated detail link',()=>{
 const r=renderVoiceCallEmail({locale:'zh-Hans',shop:'Spa <test>',from:'+16676606667',startedAt:'2026-09-20T19:50:17Z',timezone:'America/New_York',durationSeconds:62,summary:'Asked about services <script>',detailUrl:'https://desk.geniefront.com/calls?call=123',turns:[{role:'assistant',text:'Hello',startSeconds:0},{role:'user',text:'<img src=x>',startSeconds:3}]});
 expect(r.html).toContain('AI 接待');expect(r.html).toContain('客户');expect(r.html).toContain('00:03');
 expect(r.html).toContain('&lt;img');expect(r.html).not.toContain('<script>');expect(r.html).not.toContain('<pre>');
 expect(r.html).toContain('calls?call=123');expect(r.text).toContain('+1 667 660 6667');expect(r.text).not.toContain('计费分钟');
});
