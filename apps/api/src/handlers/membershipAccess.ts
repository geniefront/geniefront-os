import {randomBytes,randomUUID} from 'node:crypto';
import {AppError,ERROR_CODES,CommerceManageMembershipAccess,membershipAccessText} from '@gf/contracts';
import {registerHandler} from '../bus';
import {hashManageToken,wrapManageToken} from '../public/bookingToken';
import {commerceReturnBase} from '../commerce/provider';
import {escapeHtml} from '../email/layout';
function invalid(reason:string):never{throw new AppError(ERROR_CODES.VALIDATION_FAILED,{details:{reason}});}
registerHandler(CommerceManageMembershipAccess,async({tx,input,audit})=>{
 const [m]=await tx`select m.*,c.email,c.locale,l.slug from customer_paid_memberships m join customers c on c.id=m.customer_id join locations l on l.id=m.location_id where m.id=${input.membershipId} for update of m`;
 if(!m)throw new AppError(ERROR_CODES.NOT_FOUND);
 if(m.manage_access_version!==input.expectedVersion)invalid('membership_access_changed');
 const [paid]=await tx`select max(period_end) as covered_until from customer_membership_invoices where membership_id=${m.id}`;
 if(!paid?.covered_until)invalid('membership_access_requires_paid_invoice');
 if(input.action==='revoke'){
  if(m.manage_token_revoked_at)return {accessVersion:m.manage_access_version,noticeQueued:false,expiresAt:null};
  await tx`update customer_paid_memberships set manage_token_revoked_at=now(),manage_access_version=manage_access_version+1 where id=${m.id}`;
  audit({entityType:'customer_paid_membership',entityId:m.id,after:{accessRevoked:true,accessVersion:m.manage_access_version+1,reason:input.reason}});
  return {accessVersion:m.manage_access_version+1,noticeQueued:false,expiresAt:null};
 }
 if(!m.email||input.expectedEmail!==m.email)invalid('membership_access_changed');
 const token=`cm_${randomBytes(32).toString('base64url')}`,wrapped=wrapManageToken(token);if(!wrapped)throw new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE);
 const url=`${commerceReturnBase()}/${encodeURIComponent(m.slug)}/memberships?member=${m.id}#m/${token}`,locale=m.locale??'en';
 const [updated]=await tx`update customer_paid_memberships set manage_token_hash=${hashManageToken(token)},manage_token_wrapped=${wrapped},manage_token_revoked_at=null,
  manage_token_expires_at=greatest(now(),${paid.covered_until}::timestamptz)+interval '30 days',manage_access_version=manage_access_version+1 where id=${m.id} returning manage_access_version,manage_token_expires_at`;
 const lines=[membershipAccessText(locale,'title'),membershipAccessText(locale,'hint'),url],noticeId=randomUUID();
 await tx`insert into email_outbox(org_id,location_id,kind,to_email,subject,body_html,body_text,entity_type,entity_id,commerce_order_id)
  values(${m.org_id},${m.location_id},'platform_notice',${m.email},${membershipAccessText(locale,'title')},${`<p>${lines.map(escapeHtml).join('</p><p>')}</p>`},${lines.join('\n')},'customer_membership_access',${noticeId},${m.original_order_id})`;
 audit({entityType:'customer_paid_membership',entityId:m.id,after:{accessReissued:true,accessVersion:updated!.manage_access_version,noticeQueued:true,reason:input.reason}});
 return {accessVersion:updated!.manage_access_version,noticeQueued:true,expiresAt:new Date(updated!.manage_token_expires_at).toISOString()};
});
