import {ValidateCustomerEmails,RequestEmailDomain,SetEmailSender,RecheckEmailDomain,AppError,ERROR_CODES} from '@gf/contracts';
import {registerHandler} from '../bus';
import {normalizeEmailDomain} from '../email/domains';
registerHandler(RequestEmailDomain,async({input,ctx,tx,audit})=>{
 let domain:string;
 try{domain=normalizeEmailDomain(input.domain);}catch{throw new AppError(ERROR_CODES.VALIDATION_FAILED,{details:{reason:'invalid_or_platform_domain'}});}
 const [count]=await tx<{n:number}[]>`select count(*)::int as n from email_domain_requests where location_id=${ctx.locationId} and status<>'cancelled'`;
 if((count?.n??0)>=5) throw new AppError(ERROR_CODES.VALIDATION_FAILED,{details:{reason:'domain_limit'}});
 const [r]=await tx<{id:string}[]>`insert into email_domain_requests(org_id,location_id,domain,managed_by)
 values(${ctx.orgId},${ctx.locationId},${domain},${input.managedBy}) on conflict(domain) do nothing returning id`;
 if(!r)throw new AppError(ERROR_CODES.VALIDATION_FAILED,{details:{reason:'domain_unavailable'}});
 audit({entityType:'email_domain_request',entityId:r.id,after:{domain,managedBy:input.managedBy}});
 return{requestId:r.id};
});
registerHandler(SetEmailSender,async({input,ctx,tx,audit})=>{
 if(input.useCustom){
 const [r]=await tx`select id from email_domain_requests where id=${input.requestId} and org_id=${ctx.orgId} and location_id=${ctx.locationId} and status='verified'`;
 if(!r)throw new AppError(ERROR_CODES.VALIDATION_FAILED,{details:{reason:'domain_not_verified'}});
 }
 await tx`insert into email_sender_settings(org_id,location_id,domain_request_id,use_custom,from_local,reply_to)
 values(${ctx.orgId},${ctx.locationId},${input.useCustom?input.requestId:null},${input.useCustom},${input.fromLocal},${input.replyTo})
 on conflict(location_id) do update set domain_request_id=excluded.domain_request_id,use_custom=excluded.use_custom,from_local=excluded.from_local,reply_to=excluded.reply_to,updated_at=now()`;
 audit({entityType:'email_sender',entityId:ctx.locationId,after:input});return{saved:true};
});
registerHandler(RecheckEmailDomain,async({input,ctx,tx,audit})=>{
 const rows=await tx`update email_domain_requests set checked_at=null where id=${input.requestId} and location_id=${ctx.locationId} and status<>'cancelled'
 and (checked_at is null or checked_at<now()-interval '1 minute') returning id`;
 audit({entityType:'email_domain_request',entityId:input.requestId,after:{action:'recheck'}});return{queued:rows.length>0};
});

registerHandler(ValidateCustomerEmails,async({input,ctx,tx,audit})=>{
 const emails=[...new Set(input.emails.map(e=>e.toLowerCase().trim()))];
 const [{count}={count:0}]=await tx<{count:number}[]>`select count(*)::int as count from email_validation_cache where location_id=${ctx.locationId} and checked_at>now()-interval '1 hour'`;
 // 额度按本批实际入队量扣减，单批也不得越过每小时上限。
 const remaining=250-count;
 if(remaining<=0)throw new AppError(ERROR_CODES.VALIDATION_FAILED,{details:{reason:'validation_hourly_limit'}});
 const customers=await tx<{email:string}[]>`select distinct lower(email) as email from customers where org_id=${ctx.orgId} and lower(email)=any(${emails})`;
 let queued=0;
 for(const c of customers){
 if(queued>=remaining)break;
 const rows=await tx`insert into email_validation_cache(org_id,location_id,email,result,reason,expires_at,requested)
 values(${ctx.orgId},${ctx.locationId},${c.email},'unknown','queued',now(),true)
 on conflict(org_id,location_id,email) do update set requested=true where email_validation_cache.expires_at<=now() returning email`;
 queued+=rows.length;
 }
 audit({entityType:'email_validation',entityId:ctx.locationId,after:{queued}});return{queued};
});
