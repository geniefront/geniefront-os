import { randomBytes, createCipheriv } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { sql, withTenant, jsonb, type TenantContext } from '@gf/db';
import { elasticRequest, elasticKey, elasticDomainReady, ElasticError, type ElasticDomain } from './elastic';
import { domainInstructions, txtRecords } from './domains';
import { validateEmail } from './validation';
import { reconcileEmail } from './events';
import { isCaptureMode } from '../comms/mode';
import { mailslurpEnabled, mailslurpCreateInbox, mailslurpAttachWebhook } from './mailslurp';
import { emailProvider } from './provider';
import { mailerooDomain, mailerooRequest, type MailerooDomain } from './maileroo';

export function encryptEmailKey(value:string,context:string):string {
  const raw=process.env['EMAIL_CREDENTIAL_ENCRYPTION_KEY'];
  const key=raw?Buffer.from(raw,'base64'):Buffer.alloc(0);
  if(key.length!==32) throw new Error('email_encryption_key_not_configured');
  const iv=randomBytes(12), cipher=createCipheriv('aes-256-gcm',key,iv);
  cipher.setAAD(Buffer.from(context));
  const encrypted=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);
  return [iv,cipher.getAuthTag(),encrypted].map(x=>x.toString('base64')).join('.');
}
export async function provisionEmailAccount(tenant:TenantContext):Promise<void> {
  if(!tenant.locationId) return;
  if (emailProvider() === 'maileroo') {
    // Marketing accounts are not active yet; no legacy provider resources should be provisioned.
    await withTenant(tenant, tx => tx`insert into email_accounts(org_id,location_id,account_email,status,last_error)
      values(${tenant.orgId},${tenant.locationId},${`shop-${tenant.locationId}@tenant.geniefront.com`},'paused','marketing_coming_soon')
      on conflict(location_id) do nothing`);
    await withTenant(tenant, tx => tx`update email_accounts set status='paused',last_error='marketing_coming_soon',updated_at=now()
      where location_id=${tenant.locationId} and status in ('pending','error')`);
    return;
  }
  // Validate the wrapping key before creating any remote credentials.
  encryptEmailKey('preflight',tenant.locationId);
  const email=`shop-${tenant.locationId}@tenant.geniefront.com`;
  const [claim]=await withTenant(tenant,async tx=>{
    await tx`insert into email_accounts(org_id,location_id,account_email) values(${tenant.orgId},${tenant.locationId},${email}) on conflict(location_id) do nothing`;
    return tx<{key_encrypted:string|null}[]>`update email_accounts set attempted_at=now() where location_id=${tenant.locationId}
      and status in ('pending','error') and (attempted_at is null or attempted_at<now()-interval '15 minutes') returning key_encrypted`;
  });
  if(!claim) return;
  if(mailslurpEnabled()){
    try{
      const inbox=await mailslurpCreateInbox(`shop-${tenant.locationId}`);
      if(process.env['API_HOST']){
        try{await mailslurpAttachWebhook(inbox.id,`https://${process.env['API_HOST']}/v1/webhooks/mailslurp`);}catch{/* non-fatal */}
      }
      const wrapped=encryptEmailKey(inbox.id,tenant.locationId);
      await withTenant(tenant,tx=>tx`update email_accounts set account_email=${inbox.emailAddress},provider_account_id=${inbox.id},key_encrypted=${wrapped},status='ready',last_error=null,updated_at=now() where location_id=${tenant.locationId}`);
      return;
    }catch(e){
      await withTenant(tenant,tx=>tx`update email_accounts set status='error',last_error=${e instanceof Error?e.message:'mailslurp_provisioning_failed'},updated_at=now() where location_id=${tenant.locationId}`);
      return;
    }
  }
  try {
    let account:{PublicAccountID:string};
    try{account=await elasticRequest('GET',`/subaccounts/${encodeURIComponent(email)}`);}
    catch(e){
      if(!(e instanceof ElasticError) || (e.status!==404 && e.detail!=='subaccount_missing')) throw e;
      account=await elasticRequest('POST','/subaccounts',{
        Email:email,Password:randomBytes(36).toString('base64url'),SendActivation:false,
        // No credits allocated: provision identity now, marketing activation is Phase 2.
        Settings:{Email:{RequiresEmailCredits:true,DailySendLimit:1,ValidSenderDomainOnly:true}},
      });
    }
    // 重试不得重复签发凭据：已保存的密钥直接复用，避免在供应商侧堆积无人回收的 key。
    let wrapped=claim.key_encrypted;
    if(!wrapped){
      const credential=await elasticRequest<{Token:string}>('POST','/security/apikeys',{
        Name:`gf-marketing-${randomBytes(6).toString('hex')}`,Subaccount:email,AccessLevel:['SendHttp','ViewReports','ViewSettings'],
      });
      if(!credential.Token) throw new Error('missing_subaccount_key');
      wrapped=encryptEmailKey(credential.Token,tenant.locationId);
    }
    await withTenant(tenant,tx=>tx`update email_accounts set provider_account_id=${account.PublicAccountID},key_encrypted=${wrapped},status='ready',last_error=null,updated_at=now() where location_id=${tenant.locationId}`);
  }catch(e){
    await withTenant(tenant,tx=>tx`update email_accounts set status='error',last_error=${e instanceof ElasticError?e.message:'provisioning_failed'},updated_at=now() where location_id=${tenant.locationId}`);
  }
}
export async function refreshEmailDomains(tenant:TenantContext):Promise<void> {
  const rows=await withTenant(tenant,tx=>tx<{id:string;domain:string;ownership_token:string}[]>`
    update email_domain_requests set checked_at=now() where location_id=${tenant.locationId} and status<>'cancelled'
    and (checked_at is null or checked_at<now()-interval '15 minutes') returning id,domain,ownership_token`);
  for(const r of rows){
    let records=await domainInstructions(r.domain,r.ownership_token);
    let status='dns_pending', error:string|null=null;
    try{
      // Verify tenant control before registering the domain in the shared transactional account.
      const ownership=await txtRecords(`_geniefront.${r.domain}`);
      if(ownership.includes(`gf-domain=${r.ownership_token}`)){
        if (emailProvider() === 'maileroo') {
          const found = await mailerooDomain(r.domain);
          const d = found ? await mailerooRequest<MailerooDomain>(`/domains/${found.id}`)
            : await mailerooRequest<MailerooDomain>('/domains', 'POST', { type: 'custom', domain_name: r.domain });
          await mailerooRequest(`/domains/${d.id}/scan-dns`, 'POST');
          records = await domainInstructions(r.domain, r.ownership_token, d);
          if (d.status) {
            const appId = process.env['MAILEROO_APPLICATION_ID'];
            if (!appId) throw new Error('maileroo_application_not_configured');
            // Both API replicas share the application; serialize read-modify-write domain grants.
            await withTenant(tenant, async tx => {
              await tx`select pg_advisory_xact_lock(hashtext('maileroo-domain-grants'),hashtext(${appId}))`;
              const app = await mailerooRequest<{ authorized_domains: { domain_id: number }[] }>(`/applications/${encodeURIComponent(appId)}`);
              if (!app.authorized_domains.some(a => a.domain_id === d.id)) await mailerooRequest(`/applications/${encodeURIComponent(appId)}`, 'PATCH', {
                authorized_domains: [...app.authorized_domains.map(a => a.domain_id), d.id],
              });
            });
            status = 'verified';
          }
        } else {
        try{await elasticRequest('GET',`/domains/${encodeURIComponent(r.domain)}`);}
        catch(e){if(!(e instanceof ElasticError)||e.status!==404) throw e;await elasticRequest('POST','/domains',{Domain:r.domain,SetAsDefault:false});}
        const d=await elasticRequest<ElasticDomain>('PUT',`/domains/${encodeURIComponent(r.domain)}/verification`,'None');
        if(elasticDomainReady(d)) status='verified';
        }
      }
    }catch(e){status='error';error=e instanceof ElasticError?e.message:'domain_verification_failed';}
    await withTenant(tenant,tx=>tx`update email_domain_requests set dns_records=${jsonb(records)}::jsonb,status=${status},last_error=${error},updated_at=now() where id=${r.id} and status<>'cancelled'`);
  }
}
export async function runEmailService():Promise<void>{
  if(process.env['NODE_ENV']==='test') return;
  if (isCaptureMode() && !mailslurpEnabled()) return;
  if(emailProvider() !== 'maileroo' && !mailslurpEnabled() && !elasticKey()) return;
  const tenants=await sql<{org_id:string;location_id:string}[]>`select * from gf_email_service_tenants(50)`;
  for(const r of tenants){
    const tenant={orgId:r.org_id,locationId:r.location_id,membershipId:null};
    try{
      const requested=await withTenant(tenant,tx=>tx<{email:string}[]>`select email from email_validation_cache
        where org_id=${tenant.orgId} and location_id=${tenant.locationId} and requested=true order by checked_at limit 100`);
      for(const v of requested){
        // 请求标记在真正尝试过之后才清除；进程中断时排队的地址不会被静默丢弃。
        await validateEmail(v.email,tenant);
        await withTenant(tenant,tx=>tx`update email_validation_cache set requested=false
          where org_id=${tenant.orgId} and location_id=${tenant.locationId} and email=${v.email}`);
      }
      try { await provisionEmailAccount(tenant); } catch { /* Missing provisioning config must not stop delivery reconciliation. */ }
      if (!isCaptureMode()) {
        await withTenant(tenant,tx=>tx`update email_outbox set status='uncertain',last_error='delivery_claim_expired' where location_id=${tenant.locationId} and status='sending' and claimed_at<now()-interval '5 minutes'`);
        if (emailProvider() === 'maileroo' || elasticKey()) {
          try { await refreshEmailDomains(tenant); } catch { /* Domain outages must not block delivery reconciliation. */ }
        }
        const pending=await withTenant(tenant,tx=>tx<{provider_transaction_id:string}[]>`
          select distinct provider_transaction_id from email_outbox where location_id=${tenant.locationId}
          and provider='elasticemail' and status='sent' and provider_transaction_id is not null and sent_at>now()-interval '6 days'
          and (last_reconciled_at is null or last_reconciled_at<now()-interval '15 minutes') limit 20`);
        if (elasticKey()) for(const p of pending) await reconcileEmail(tenant,p.provider_transaction_id);
      }
    }catch{ /* Other tenants still progress; detailed statuses are persisted per resource. */ }
  }
}
export function startEmailService(app:FastifyInstance):void{
  let running=false;
  const run=async()=>{if(running)return;running=true;try{await runEmailService();}catch{app.log.warn('email service sweep failed');}finally{running=false;}};
  void run();const timer=setInterval(()=>void run(),60_000);timer.unref();app.addHook('onClose',async()=>clearInterval(timer));
}
