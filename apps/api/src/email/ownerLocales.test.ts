import {it,expect} from 'vitest';
import {OWNER_LOCALES} from './locale';
import {renderTrialEnding,renderPaymentFailed,renderSubscriptionCanceled,renderLicenseExpiring,renderConfirm} from './render';
import {renderVoiceCallEmail} from './voiceCall';
const expected={en:'subscription','zh-Hans':'订阅','zh-Hant':'訂閱',ko:'구독',vi:'đăng ký',es:'suscripción'};
for(const locale of OWNER_LOCALES)it(`renders owner billing and call email in ${locale}`,()=>{
 const common={locale,shopName:'Spa',billingUrl:'https://desk.example/billing'};
 const trial=renderTrialEnding({...common,chargeDateText:'DATE',planLabel:'Essential',monthlyText:'$99'});
 const failed=renderPaymentFailed({...common,amountText:'$99',nextAttemptText:'DATE'});
 const cancelled=renderSubscriptionCanceled({...common,endsAtText:null,atPeriodEnd:true});
 const license=renderLicenseExpiring({...common,endsAtText:'DATE',daysLeft:3});
 expect(failed.text.toLowerCase()).toContain(expected[locale]);
 for(const mail of [trial,failed,cancelled,license]){expect(mail.html).not.toContain('undefined');expect(mail.text).not.toContain('{date}');}
 const call=renderVoiceCallEmail({locale,shop:'Spa',from:'+16175550123',timezone:'America/New_York',durationSeconds:62,summary:'',turns:[],detailUrl:'https://desk.example/calls'});
 const title={en:'Call record','zh-Hans':'来电记录','zh-Hant':'來電記錄',ko:'통화 기록',vi:'Lịch sử cuộc gọi',es:'Registro de llamada'}[locale];
 expect(call.subject).toContain(title);expect(call.html).not.toContain('undefined');
 if(locale==='en')expect(call.html).not.toMatch(/[\u4e00-\u9fff]/u);
});
it('customer confirmation remains English',()=>{
 const mail=renderConfirm({customerName:'Amy',shopName:'Spa',serviceName:'Massage',whenText:'Sep 22 2pm',staffName:null,shopPhone:null});
 expect(mail.subject).toContain('Appointment confirmed');expect(mail.html).not.toMatch(/[\u4e00-\u9fff]/u);
});
