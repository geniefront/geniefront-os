import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {withUser,withTenant,platformStoreDetail} from '@gf/db';
import {AppError,ERROR_CODES} from '@gf/contracts';
import {requirePlatformOperator} from './auth';
import {writePlatformAudit} from './audit';
import {emailPanel} from '../email/routes';
import {elasticRequest,elasticTrackingLocked,type ElasticDomain} from '../email/elastic';
import {emailProvider} from '../email/provider';
import {mailerooDomains,mailerooRequest,type MailerooDomain} from '../email/maileroo';

export function registerPlatformEmailRoutes(app:FastifyInstance){
 const operator=(req:FastifyRequest)=>requirePlatformOperator(req.user?.userId);
 app.get('/v1/platform/email',async req=>{
  const op=await operator(req);
  const requests=await withUser(op.userId,tx=>tx`select id,org_id,location_id,domain,managed_by,status,dns_records,last_error,note,checked_at,created_at from email_domain_requests order by created_at desc limit 200`);
  const accounts=await withUser(op.userId,tx=>tx`select location_id,account_email,status,last_error,updated_at from email_accounts order by created_at desc limit 200`);
  let domains:ElasticDomain[]=[];let providerError:string|null=null;
  try{
   domains=emailProvider()==='maileroo'?await Promise.all((await mailerooDomains()).map(async d=>{
    const detail=await mailerooRequest<MailerooDomain>(`/domains/${d.id}`);
    return {Domain:d.domain_name,Spf:detail.dns_records?.spf_record.created===true,Dkim:detail.dns_records?.dkim_record.created===true,DMARC:detail.dns_records?.dmarc_record.created===true,Verify:detail.status};
   })):await elasticRequest('GET','/domains');
  }catch{providerError='provider_unavailable';}
  // trackingLocked：账户拒绝按邮件关闭追踪，事务邮件已退回账户默认设置，链接会被改写。
  return{provider:emailProvider(),domains:domains.map(({Domain,Spf,Dkim,DMARC,Verify})=>({Domain,Spf,Dkim,DMARC,Verify})),requests,accounts,providerError,marketingAvailable:false,trackingLocked:emailProvider()==='elasticemail'&&elasticTrackingLocked()};
 });
 app.get('/v1/platform/stores/:locationId/email',async req=>{
  const op=await operator(req),locationId=z.string().uuid().parse((req.params as {locationId:string}).locationId);
  const detail=await platformStoreDetail(op.userId,locationId) as {overview:{orgId:string}};
  if(!detail?.overview?.orgId)throw new AppError(ERROR_CODES.NOT_FOUND);
  return emailPanel({orgId:detail.overview.orgId,locationId,membershipId:null});
 });
 // Named operator mutations: authorize, validate, write and audit atomically.
 app.post('/v1/platform/email/requests/:id',async req=>{
  const op=await operator(req),id=z.string().uuid().parse((req.params as {id:string}).id);
  const input=z.object({action:z.enum(['recheck','cancel','note']),note:z.string().max(2000).default('')}).parse(req.body);
  const [r]=await withUser(op.userId,tx=>tx<{org_id:string;location_id:string}[]>`select org_id,location_id from email_domain_requests where id=${id}`);
  if(!r)throw new AppError(ERROR_CODES.NOT_FOUND);
  return withTenant({orgId:r.org_id,locationId:r.location_id,membershipId:null},async tx=>{
   await tx`update email_domain_requests set note=${input.note},checked_at=case when ${input.action==='recheck'} then null else checked_at end,
    status=case when ${input.action==='cancel'} then 'cancelled' else status end,updated_at=now() where id=${id}`;
   if(input.action==='cancel')await tx`update email_sender_settings set use_custom=false where domain_request_id=${id}`;
   await writePlatformAudit(tx,op,{orgId:r.org_id,locationId:r.location_id,command:`email.domain.${input.action}`,entityId:id,after:input});
   return{ok:true};
  });
 });
 app.post('/v1/platform/email/accounts/:locationId',async req=>{
  const op=await operator(req),locationId=z.string().uuid().parse((req.params as {locationId:string}).locationId);
  const input=z.object({action:z.enum(['retry','pause'])}).parse(req.body);
  const [r]=await withUser(op.userId,tx=>tx<{org_id:string}[]>`select org_id from email_accounts where location_id=${locationId}`);
  if(!r)throw new AppError(ERROR_CODES.NOT_FOUND);
  return withTenant({orgId:r.org_id,locationId,membershipId:null},async tx=>{
   await tx`update email_accounts set status=${input.action==='pause'?'paused':'pending'},attempted_at=null,updated_at=now() where location_id=${locationId}`;
   await writePlatformAudit(tx,op,{orgId:r.org_id,locationId,command:`email.account.${input.action}`,after:input});return{ok:true};
  });
 });
}
