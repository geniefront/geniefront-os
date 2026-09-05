import {beforeAll,afterAll,afterEach,describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {withTenant,closeDb} from '@gf/db';
import {buildServer} from './server';
import {interpretValidation} from './email/validation';
import {elasticRequest,elasticSendEmail,ElasticError,elasticDomainReady,elasticTrackingLocked,resetElasticTrackingProbe} from './email/elastic';
import {normalizeEmailDomain} from './email/domains';
import {eventState,reconcileEmail} from './email/events';
import {elasticWebhookPathToken} from './email/routes';
import {flushEmails} from './email/flush';
import {emailProvider} from './email/provider';
import {sendEmail} from './email/send';
import {mintUnsubscribeToken} from './email/unsubscribe';
import {__resetRateLimit} from './public/rateLimit';
const tenant={orgId:'11111111-1111-4111-8111-111111111111',locationId:'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',membershipId:null};
const other={orgId:'22222222-2222-4222-8222-222222222222',locationId:'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',membershipId:null};
let app:ReturnType<typeof buildServer>;
beforeAll(async()=>{app=buildServer();await app.ready();});
afterAll(async()=>{await app.close();await closeDb();});
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();__resetRateLimit();resetElasticTrackingProbe();});
describe('Elastic Email Phase 1',()=>{
 it('strict provider selection',()=>{
  expect(emailProvider({EMAIL_PROVIDER:'elasticemail'} as NodeJS.ProcessEnv)).toBe('elasticemail');
  expect(()=>emailProvider({EMAIL_PROVIDER:'resned'} as NodeJS.ProcessEnv)).toThrow('invalid_email_provider');
 });
 it('keeps predictions, roles and unknowns from permanently blocking receipts',()=>{
  expect(interpretValidation({Result:'Unknown',PredictedStatus:'Invalid'}).result).toBe('unknown');
  expect(interpretValidation({Result:'Valid',Role:true}).result).toBe('valid');
  expect(interpretValidation({Result:'Valid',Disposable:true}).result).toBe('risky');
  expect(interpretValidation({Result:'Invalid'}).result).toBe('invalid');
  expect(interpretValidation({Result:'Invalid',Reason:'Service error'}).result).toBe('unknown');
  expect(interpretValidation({Result:'Invalid',Reason:'Connection timeout'}).result).toBe('unknown');
 });
 it('uses one transactional recipient and does not rewrite booking/auth links',async()=>{
  const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify({MessageID:'m',TransactionID:'t'}),{status:200}));
  vi.stubGlobal('fetch',fetch);vi.stubEnv('ELASTICEMAIL_API_KEY','test-key');
  await elasticSendEmail({from:'booking@book.geniefront.com',to:'one@example.com',subject:'Booking',html:'<p>Hello</p>',text:'Hello'});
  const [url,opts]=fetch.mock.calls[0]!;expect(url).toContain('/emails/transactional');
  const body=JSON.parse(opts.body);expect(body.Recipients).toEqual({To:['one@example.com']});
  expect(body.Options).toEqual({TrackOpens:false,TrackClicks:false});expect(body.Content.Headers).toBeUndefined();
 });
 it('does not expose provider error bodies containing secrets',async()=>{
  vi.stubEnv('ELASTICEMAIL_API_KEY','test-key');vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('secret-test',{status:401})));
  await expect(elasticSendEmail({from:'a@example.com',to:'b@example.com',subject:'s',html:'h',text:'t'})).rejects.toThrow('elastic_email_http_401');
  expect(new ElasticError(429).permanent).toBe(false);
 });
 it('recognizes authenticated domains even with Verify false; rejects platform domain claims',()=>{
  expect(elasticDomainReady({Domain:'book.geniefront.com',Spf:true,Dkim:true,DMARC:true,Verify:false})).toBe(true);
  expect(()=>normalizeEmailDomain('book.geniefront.com')).toThrow();
  expect(()=>normalizeEmailDomain('https://salon.com')).toThrow();
  expect(normalizeEmailDomain('MAIL.SALON.COM')).toBe('mail.salon.com');
 });
 it('separates temporary errors from nonexistent mailboxes',()=>{
  const ev={MsgID:'m',TransactionID:'t',To:'a@b.com',EventType:'Bounce',EventDate:''};
  expect(eventState({...ev,MessageCategory:'Timeout'})).toBe('soft_bounce');
  expect(eventState({...ev,MessageCategory:'NoMailbox'})).toBe('hard_bounce');
 });
 it('blocks marketing even in capture mode',async()=>{
  const r=await sendEmail({to:'one@example.com',subject:'Promo',html:'promo',text:'promo',unsubscribeUrl:'https://example.com/unsubscribe'});
  expect(r).toMatchObject({ok:false,permanent:true,error:'marketing_coming_soon'});
 });
 it('new control tables enforce tenant and composite domain ownership',async()=>{
  const [r]=await withTenant(tenant,tx=>tx<{id:string}[]>`insert into email_domain_requests(org_id,location_id,domain,managed_by)
    values(${tenant.orgId},${tenant.locationId},${`test-${randomUUID()}.com`},'customer') returning id`);
  const rows=await withTenant(other,tx=>tx`select id from email_domain_requests where id=${r!.id}`);expect(rows).toHaveLength(0);
  await expect(withTenant(other,tx=>tx`insert into email_sender_settings(org_id,location_id,domain_request_id)
   values(${other.orgId},${other.locationId},${r!.id})`)).rejects.toThrow();
 });
 it('concurrent flushes deliver a row once',async()=>{
  const id=randomUUID();
  await withTenant(tenant,tx=>tx`insert into email_outbox(id,org_id,location_id,kind,to_email,subject,body_html,body_text,entity_type,entity_id)
   values(${id},${tenant.orgId},${tenant.locationId},'appointment_confirm','flush@example.com','Booking','html','text','elastic_test',${id})`);
  await Promise.all([flushEmails(tenant),flushEmails(tenant)]);
  const [r]=await withTenant(tenant,tx=>tx<{status:string;attempts:number}[]>`select status,attempts from email_outbox where id=${id}`);
  expect(r).toEqual({status:'captured',attempts:1});
 });
 it('webhook GET is reachable without a login, POST requires its own credential',async()=>{
  expect((await app.inject({method:'GET',url:'/v1/webhooks/elasticemail'})).statusCode).toBe(200);
  expect((await app.inject({method:'POST',url:'/v1/webhooks/elasticemail',payload:{}})).statusCode).toBe(401);
 });
 it('RFC8058 form POST unsubscribes without authentication and preserves other orgs',async()=>{
  vi.stubEnv('APP_JWT_SECRET','test-unsubscribe-secret');
  const [c]=await withTenant(tenant,tx=>tx<{id:string}[]>`insert into customers(org_id,primary_location_id,display_name,email,marketing_email_opt_in)
   values(${tenant.orgId},${tenant.locationId},'Unsub','test-unsubscribe@example.com',true) returning id`);
  const token=mintUnsubscribeToken({customerId:c!.id,orgId:tenant.orgId});
  const url=`/public/v1/email/unsubscribe?t=${token}`;
  await app.inject({method:'GET',url});
  const [before]=await withTenant(tenant,tx=>tx`select marketing_email_opt_in from customers where id=${c!.id}`);expect(before!.marketing_email_opt_in).toBe(true);
  const response=await app.inject({method:'POST',url,headers:{'content-type':'application/x-www-form-urlencoded'},payload:'List-Unsubscribe=One-Click'});
  expect(response.statusCode).toBe(200);
  const [after]=await withTenant(tenant,tx=>tx`select marketing_email_opt_in from customers where id=${c!.id}`);expect(after!.marketing_email_opt_in).toBe(false);
 });
 it('falls back to account tracking defaults only when the account refuses the option',async()=>{
  vi.stubEnv('ELASTICEMAIL_API_KEY','test-key');
  const fetch=vi.fn()
   .mockResolvedValueOnce(new Response('{"Error":"You cannot change the tracking options","RelatedTo":"trackOpens"}',{status:400}))
   .mockImplementation(()=>Promise.resolve(new Response(JSON.stringify({MessageID:'m',TransactionID:'t'}),{status:200})));
  vi.stubGlobal('fetch',fetch);
  await expect(elasticSendEmail({from:'a@book.geniefront.com',to:'b@example.com',subject:'s',html:'h',text:'t'})).resolves.toMatchObject({MessageID:'m'});
  expect(JSON.parse(fetch.mock.calls[0]![1].body).Options).toEqual({TrackOpens:false,TrackClicks:false});
  expect(JSON.parse(fetch.mock.calls[1]![1].body).Options).toBeUndefined();
  expect(elasticTrackingLocked()).toBe(true);
  // 该限制记住一次即可，之后不再每封都先失败一次。
  await elasticSendEmail({from:'a@book.geniefront.com',to:'c@example.com',subject:'s',html:'h',text:'t'});
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(JSON.parse(fetch.mock.calls[2]![1].body).Options).toBeUndefined();
 });
 it('does not silently retry other rejections without the tracking options',async()=>{
  vi.stubEnv('ELASTICEMAIL_API_KEY','test-key');
  const fetch=vi.fn().mockResolvedValue(new Response('{"Error":"Sender domain is not verified"}',{status:400}));
  vi.stubGlobal('fetch',fetch);
  await expect(elasticSendEmail({from:'a@example.com',to:'b@example.com',subject:'s',html:'h',text:'t'})).rejects.toThrow('elastic_email_http_400');
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(elasticTrackingLocked()).toBe(false);
 });
 it('accepts the provider notification URL token and rejects a wrong one',async()=>{
  vi.stubEnv('ELASTICEMAIL_WEBHOOK_SECRET','test-webhook-secret');
  const token=elasticWebhookPathToken('test-webhook-secret')!;
  expect(token).toHaveLength(32);
  expect((await app.inject({method:'GET',url:`/v1/webhooks/elasticemail/${token}`})).statusCode).toBe(200);
  expect((await app.inject({method:'POST',url:`/v1/webhooks/elasticemail/${token}`,payload:{}})).statusCode).toBe(200);
  expect((await app.inject({method:'POST',url:`/v1/webhooks/elasticemail/${'0'.repeat(32)}`,payload:{}})).statusCode).toBe(401);
  expect((await app.inject({method:'POST',url:'/v1/webhooks/elasticemail',payload:{}})).statusCode).toBe(401);
 });
 it('reconciles out-of-order provider events without downgrading or leaking across tenants',async()=>{
  vi.stubEnv('ELASTICEMAIL_API_KEY','test-key');
  const id=randomUUID(),transaction=randomUUID(),messageId=randomUUID();
  const recipient=`bounce-${id}@example.com`;
  await withTenant(tenant,tx=>tx`insert into email_outbox(id,org_id,location_id,kind,to_email,subject,body_html,body_text,entity_type,entity_id,
    status,provider,provider_account,provider_id,provider_transaction_id,sent_at)
   values(${id},${tenant.orgId},${tenant.locationId},'appointment_confirm',${recipient},'Booking','html','text','elastic_test',${id},
    'sent','elasticemail','main',${messageId},${transaction},now())`);
  const [mine]=await withTenant(tenant,tx=>tx<{id:string}[]>`insert into customers(org_id,primary_location_id,display_name,email,marketing_email_opt_in)
   values(${tenant.orgId},${tenant.locationId},'Bounced',${recipient},true) returning id`);
  const [theirs]=await withTenant(other,tx=>tx<{id:string}[]>`insert into customers(org_id,primary_location_id,display_name,email,marketing_email_opt_in)
   values(${other.orgId},${other.locationId},'Same address',${recipient},true) returning id`);
  const base={TransactionID:transaction,To:recipient,EventDate:''};
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify([
   {...base,MsgID:messageId,EventType:'Bounce',MessageCategory:'NoMailbox'},
   // 迟到的成功事件、重复事件和别人的事务都不得改写最终状态。
   {...base,MsgID:messageId,EventType:'Sent'},
   {...base,MsgID:messageId,EventType:'Bounce',MessageCategory:'NoMailbox'},
   {...base,MsgID:messageId,TransactionID:randomUUID(),EventType:'Sent'},
   {...base,MsgID:randomUUID(),EventType:'Sent'},
  ]),{status:200})));
  await reconcileEmail(tenant,transaction);
  const [row]=await withTenant(tenant,tx=>tx<{delivery_state:string;last_reconciled_at:string|null}[]>`select delivery_state,last_reconciled_at from email_outbox where id=${id}`);
  expect(row!.delivery_state).toBe('hard_bounce');
  expect(row!.last_reconciled_at).not.toBeNull();
  const suppressed=await withTenant(tenant,tx=>tx`select scope from email_account_suppressions where email=${recipient} and provider_account='main'`);
  expect(suppressed.map(r=>(r as {scope:string}).scope)).toContain('all');
  const [after]=await withTenant(tenant,tx=>tx`select marketing_email_opt_in from customers where id=${mine!.id}`);
  expect((after as {marketing_email_opt_in:boolean}).marketing_email_opt_in).toBe(false);
  const [untouched]=await withTenant(other,tx=>tx`select marketing_email_opt_in from customers where id=${theirs!.id}`);
  expect((untouched as {marketing_email_opt_in:boolean}).marketing_email_opt_in).toBe(true);
 });
 it('treats the 400 used for a missing subaccount as absent, not as a hard failure',async()=>{
  // 供应商对不存在的子账户返回 400 而不是 404（2026-09-05 生产实测）。
  vi.stubEnv('ELASTICEMAIL_API_KEY','test-key');
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('{"Error":"Subaccount not found"}',{status:400})));
  const error=await elasticRequest('GET','/subaccounts/shop@tenant.geniefront.com').catch((e:unknown)=>e);
  expect(error).toBeInstanceOf(ElasticError);
  expect((error as ElasticError).detail).toBe('subaccount_missing');
 });
});
