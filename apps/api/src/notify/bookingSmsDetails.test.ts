import {it,expect} from 'vitest';
import {renderSmsServices,smsServiceName,type SmsServiceRow} from './bookingSmsDetails';
const base:SmsServiceRow={id:'1',name:{en:'Deep Tissue','zh-Hans':'深层按摩'},short_names:{'zh-Hans':'深层',en:'Deep'},duration_min:75,is_addon:false,addon_ids:['hot'],membership_id:'a',details:{publicGuestIndex:0,serviceExecutionGroup:'pair',smsBaseDurationMin:60}};
const addons=[{id:'hot',name:{en:'Hot Stone'},short_names:{'zh-Hans':'热石',en:'Stone'},duration_min:15}];
it('preserves each guest and add-on, but deduplicates multiple staff for the same service',()=>{
 const rows=[base,{...base,id:'2',membership_id:'b'},{...base,id:'3',duration_min:30,addon_ids:[],name:{'zh-Hans':'足部按摩'},short_names:{'zh-Hans':'足疗'},details:{publicGuestIndex:1}}];
 expect(renderSmsServices(rows,addons,'zh-Hans',2)).toBe('1:深层60分+热石; 2:足疗30分');
 expect(renderSmsServices(rows,addons,'zh-Hans',2,'b')).toBe('1:深层60分+热石');
});
it('uses the requested language and preserves fallback names without arbitrary clipping',()=>{
 expect(renderSmsServices([base],addons,'en',1)).toBe('Deep60min+Stone');
 expect(renderSmsServices([{...base,short_names:{}}],addons,'zh-Hans',1)).toBe('深层按摩60分+热石');
});

it('keeps booked duration after catalog add-on duration changes and handles shared staff rows',()=>{
 const changed=[{...addons[0]!,duration_min:45}];
 expect(renderSmsServices([base],changed,'zh-Hans',1)).toBe('深层60分+热石');
 const partner={...base,id:'2',membership_id:'b',addon_ids:[],details:{...base.details,smsBaseDurationMin:75}};
 expect(renderSmsServices([base,partner],changed,'zh-Hans',1,'b')).toBe('深层60分+热石');
 const legacy={...base,details:{}};
 expect(renderSmsServices([legacy],changed,'zh-Hans',1)).toBe('(深层+热石)75分');
});

it('renders the reported couples booking once, with one duration and a localized fallback',()=>{
 const first:SmsServiceRow={...base,name:{en:'Couples Massage 60 min','zh-Hans':'Couples Massage 60 min'},short_names:{},duration_min:70,details:{publicGuestIndex:0,publicGuestIndices:[0,1],serviceExecutionGroup:'couple',smsBaseDurationMin:60}};
 const second:SmsServiceRow={...first,id:'2',membership_id:'b',addon_ids:[],details:{...first.details,publicGuestIndex:1,smsBaseDurationMin:70}};
 const extra=[{...addons[0]!,duration_min:10}];
 expect(renderSmsServices([first,second],extra,'zh-Hans',2)).toBe('1、2:双人60分+热石');
 expect(renderSmsServices([first,second],extra,'zh-Hans',2,'b')).toBe('2:双人60分+热石');
 expect(renderSmsServices([first,second],extra,'en',2)).toBe('1,2:Couples60min+Stone');
});

it('strips existing duration suffixes from fallback service names without trimming custom identities',()=>{
 expect(smsServiceName({en:'Signature Massage 60 min'},{},'en')).toBe('Signature Massage');
 expect(smsServiceName({'zh-Hans':'深层组织按摩（90分钟）'},{},'zh-Hans')).toBe('深层组织按摩');
 expect(smsServiceName({en:'Custom Treatment'},{'zh-Hans':'自定'},'zh-Hans')).toBe('自定');
});
