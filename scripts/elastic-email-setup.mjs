#!/usr/bin/env node
/** Explicit operations, no secrets in output. Usage: node scripts/elastic-email-setup.mjs .env.production preflight|bootstrap|smtp|auth|webhook|smoke */
import {readFileSync,writeFileSync,chmodSync,existsSync} from 'node:fs';
import {parseEnv} from 'node:util';
import {randomBytes,createHash} from 'node:crypto';
const [file,mode]=process.argv.slice(2);
if(!file || !['preflight','bootstrap','smtp','auth','webhook','smoke'].includes(mode))throw new Error('Specify environment file and operation');
const env=parseEnv(readFileSync(file,'utf8'));
const key=env.ELASTICEMAIL_API_KEY||env.ELASTIC_EMAIL_API_KEY;
async function request(path,method='GET',body){
 const r=await fetch(`https://api.elasticemail.com/v4${path}`,{method,headers:{'X-ElasticEmail-ApiKey':key,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(20000)});
 if(!r.ok){const err=new Error(`Elastic Email HTTP ${r.status} at ${path.split('?')[0]}`);err.status=r.status;throw err;}
 const text=await r.text();return text?JSON.parse(text):null;
}
function save(values){
 let text=readFileSync(file,'utf8');
 for(const [name,value] of Object.entries(values)){
  const line=`${name}=${value}`;const re=new RegExp(`^${name}=.*$`,'m');text=re.test(text)?text.replace(re,line):text+`\n${line}\n`;
 }
 writeFileSync(file,text,{mode:0o600});chmodSync(file,0o600);Object.assign(env,values);
}
if(mode==='preflight'){
 const domains=await request('/domains');
 console.log(JSON.stringify({domains:domains.map(d=>({domain:d.Domain,spf:d.Spf,dkim:d.Dkim,dmarc:d.DMARC,tracking:d.TrackingStatus})),subaccounts:(await request('/subaccounts?limit=100')).length}));
}
if(mode==='bootstrap'){
 const values={};
 if(!env.ELASTICEMAIL_SEND_API_KEY){const k=await request('/security/apikeys','POST',{Name:`gf-${env.GF_ENV||'production'}-transactional-${randomBytes(4).toString('hex')}`,AccessLevel:['SendHttp']});if(!k.Token)throw new Error('Missing credential');values.ELASTICEMAIL_SEND_API_KEY=k.Token;}
 if(!env.EMAIL_CREDENTIAL_ENCRYPTION_KEY)values.EMAIL_CREDENTIAL_ENCRYPTION_KEY=randomBytes(32).toString('base64');
 if(!env.ELASTICEMAIL_WEBHOOK_SECRET)values.ELASTICEMAIL_WEBHOOK_SECRET=randomBytes(32).toString('hex');
 save(values);console.log('Saved sending credential, encryption and webhook secrets to the selected environment file. Provider is not switched by this operation.');
}
if(mode==='smtp'){
 if(!env.ELASTICEMAIL_SMTP_PASSWORD){
  const user=`auth-${env.GF_ENV||'production'}-${randomBytes(4).toString('hex')}@geniefront.com`;
  const c=await request('/security/smtp','POST',{Name:user});
  if(!c.Password)throw new Error('Missing SMTP credential');
  save({ELASTICEMAIL_SMTP_USERNAME:c.Name||user,ELASTICEMAIL_SMTP_PASSWORD:c.Password});
 }
 console.log('SMTP credential is stored in the selected environment file.');
}
if(mode==='auth'){
 if(!env.SUPABASE_ACCESS_TOKEN || !env.ELASTICEMAIL_SMTP_PASSWORD)throw new Error('Need SUPABASE_ACCESS_TOKEN and SMTP credential');
 const ref=new URL(env.SUPABASE_URL).hostname.split('.')[0];
 const url=`https://api.supabase.com/v1/projects/${ref}/config/auth`;
 const headers={'Authorization':`Bearer ${env.SUPABASE_ACCESS_TOKEN}`,'Content-Type':'application/json'};
 const before=await fetch(url,{headers});if(!before.ok)throw new Error(`Auth config read HTTP ${before.status}`);
 const backup=await before.json();
 // Local ignored backup enables exact SMTP rollback; never print the auth response.
 // 只保留首次备份：重复执行不得用已经切换过的配置覆盖回滚点。
 const backupFile=`${file}.auth-email-backup`;
 if(existsSync(backupFile))console.log('Existing rollback backup kept:',backupFile);
 else writeFileSync(backupFile,JSON.stringify(Object.fromEntries(Object.entries(backup).filter(([k])=>k.startsWith('smtp_')))),{mode:0o600});
 const patch={smtp_host:'smtp.elasticemail.com',smtp_port:'587',smtp_user:env.ELASTICEMAIL_SMTP_USERNAME,smtp_pass:env.ELASTICEMAIL_SMTP_PASSWORD,smtp_admin_email:'noreply@geniefront.com',smtp_sender_name:'GenieFront'};
 const r=await fetch(url,{method:'PATCH',headers,body:JSON.stringify(patch)});if(!r.ok)throw new Error(`Auth config update HTTP ${r.status}`);
 const after=await fetch(url,{headers});if(!after.ok)throw new Error('Auth config verification failed');const verified=await after.json();
 if(verified.smtp_host!==patch.smtp_host || verified.smtp_user!==patch.smtp_user)throw new Error('Auth SMTP config mismatch');
 console.log('Verified Auth SMTP migration for '+ref);
}
if(mode==='webhook'){
 if(!env.ELASTICEMAIL_WEBHOOK_SECRET)throw new Error('Run bootstrap first: webhook secret is missing');
 if(!env.API_HOST)throw new Error('API_HOST is required to build the notification URL');
 // 供应商只能配置 URL，没有自定义请求头，因此用密钥派生的公开标识作为路径；密钥本身不出现在 URL 里。
 const token=createHash('sha256').update(`elasticemail-webhook:${env.ELASTICEMAIL_WEBHOOK_SECRET}`).digest('hex').slice(0,32);
 const url=`https://${env.API_HOST}/v1/webhooks/elasticemail/${token}`;
 const existing=await request('/webhook');
 const found=(existing||[]).find(w=>w.URL===url);
 const payload={Name:`gf-${env.GF_ENV||'production'}-delivery`,URL:url,NotifyOncePerEmail:false,
  NotificationForSent:true,NotificationForOpened:false,NotificationForClicked:false,
  NotificationForUnsubscribed:true,NotificationForAbuseReport:true,NotificationForError:true};
 if(found)await request(`/webhook/${encodeURIComponent(found.PublicId||found.Publicid||found.publicid)}`,'PUT',payload);
 else await request('/webhook','POST',payload);
 console.log(JSON.stringify({action:found?'updated':'created',host:env.API_HOST,path:'/v1/webhooks/elasticemail/<token>',
  registered:(await request('/webhook')).length}));
}
if(mode==='smoke'){
 const to='migration-check@tenant.geniefront.com';
 const validation=await request(`/verifications/${encodeURIComponent(to)}`,'POST');console.log('Validation:',JSON.stringify({result:validation.Result,predicted:validation.PredictedStatus,reason:validation.Reason}));
 // 与运行时一致：账户不允许按邮件关闭追踪时退回账户默认设置，而不是让检查整体失败。
 let optOut=true;
 for(const from of ['noreply@geniefront.com','noreply@book.geniefront.com']){
  const content={Recipients:{To:[to]},Content:{From:from,Subject:'GenieFront email migration check',Body:[{ContentType:'PlainText',Content:'Controlled migration check for GenieFront system and booking email. No customer action or marketing subscription is created.'}]}};
  let result;
  try{result=await request('/emails/transactional','POST',optOut?{...content,Options:{TrackOpens:false,TrackClicks:false}}:content);}
  catch(e){if(!optOut||e.status!==400)throw e;optOut=false;result=await request('/emails/transactional','POST',content);}
  console.log(JSON.stringify({from,recipient:to,trackingOptOut:optOut,messageId:result.MessageID,transactionId:result.TransactionID}));
 }
 if(!optOut)console.log('Account refused per-message tracking options; messages were sent with account defaults.');
}
