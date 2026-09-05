import type {FastifyInstance,FastifyReply,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {withTenant,sql,type TenantContext} from '@gf/db';
import {AppError,ERROR_CODES} from '@gf/contracts';
import type {CtxFromHeaders} from '../routes/utils';
import {reconcileEmail} from './events';
import {createHash,timingSafeEqual} from 'node:crypto';

export async function emailPanel(tenant:TenantContext){
 return withTenant(tenant,async tx=>{
  const accounts=await tx`select account_email,status,last_error,updated_at from email_accounts where location_id=${tenant.locationId}`;
  const domains=await tx`select id,domain,managed_by,status,dns_records,last_error,note,checked_at,created_at from email_domain_requests where location_id=${tenant.locationId} order by created_at desc`;
  const settings=await tx`select domain_request_id,use_custom,from_local,reply_to from email_sender_settings where location_id=${tenant.locationId}`;
  const messages=await tx`select id,to_email,subject,kind,status,delivery_state,last_error,created_at,sent_at,from_email from email_outbox where location_id=${tenant.locationId} order by created_at desc limit 50`;
  const validation=await tx`select email,result,reason,suggested_email,checked_at from email_validation_cache where location_id=${tenant.locationId} order by checked_at desc limit 50`;
  return {account:accounts[0]??null,domains,settings:settings[0]??null,messages,validation,marketingAvailable:false,defaultSender:process.env['CUSTOMER_FROM_EMAIL']??null};
 });
}
function constantEquals(a:string,b:string):boolean{
 const x=Buffer.from(a),y=Buffer.from(b);
 return x.length===y.length && timingSafeEqual(x,y);
}
/** 由 webhook 密钥派生的公开通知标识；不可反推密钥，也不能用于其他接口。 */
export function elasticWebhookPathToken(secret=process.env['ELASTICEMAIL_WEBHOOK_SECRET']):string|null{
 return secret?createHash('sha256').update(`elasticemail-webhook:${secret}`).digest('hex').slice(0,32):null;
}
function authenticateNotification(params:{token?:string},header:unknown):boolean{
 const secret=process.env['ELASTICEMAIL_WEBHOOK_SECRET'];
 if(!secret)return false;
 if(typeof header==='string'&&constantEquals(header,secret))return true;
 const expected=elasticWebhookPathToken(secret);
 return Boolean(params.token&&expected&&constantEquals(params.token,expected));
}

export function registerEmailManagementRoutes(app:FastifyInstance,ctxFromHeaders:CtxFromHeaders){
 app.get('/v1/desk/settings/email',async req=>{
  const ctx=await ctxFromHeaders(req);if(!ctx.permissions.has('settings.manage'))throw new AppError(ERROR_CODES.PERMISSION_DENIED);
  return emailPanel(ctx);
 });
 // 供应商通知只能配置 URL，配置项里没有自定义请求头，因此除保留原有请求头方式外，
 // 另接受路径标识。路径里的是由密钥派生的公开标识而非密钥本身：即使进入访问日志也
 // 不能用于其他接口，且任何事件都要再经已认证 API 复核后才改数据库。
 app.get('/v1/webhooks/elasticemail',async()=>({ok:true}));
 app.get('/v1/webhooks/elasticemail/:token',async(req,reply)=>
  authenticateNotification(req.params as {token?:string},req.headers['x-geniefront-webhook-secret'])?{ok:true}:reply.code(401).send({ok:false}));
 const notify=async(req:FastifyRequest,reply:FastifyReply)=>{
  if(!authenticateNotification(req.params as {token?:string},req.headers['x-geniefront-webhook-secret']))return reply.code(401).send({ok:false});
  const source=typeof req.body==='string'?Object.fromEntries(new URLSearchParams(req.body))
   :{...(req.query as Record<string,unknown>),...(req.body as Record<string,unknown>|null??{})};
  const parsed=z.object({messageid:z.string().max(256).optional(),transaction:z.string().max(256).optional()}).safeParse(source);
  if(!parsed.success)return reply.code(400).send({ok:false});
  const [t]=await sql<{org_id:string;location_id:string}[]>`select * from gf_elastic_message_tenant(${parsed.data.messageid??''},${parsed.data.transaction??''})`;
  if(t && parsed.data.transaction)await reconcileEmail({orgId:t.org_id,locationId:t.location_id,membershipId:null},parsed.data.transaction);
  return{ok:true};
 };
 app.post('/v1/webhooks/elasticemail',notify);
 app.post('/v1/webhooks/elasticemail/:token',notify);
}
