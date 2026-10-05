import { withTenant, type TenantContext } from '@gf/db';
import { elasticRequest, elasticDomainReady, type ElasticDomain } from './elastic';
import { emailProvider } from './provider';
import { isCaptureMode } from '../comms/mode';
import { mailerooDomain } from './maileroo';
const APPOINTMENTS = new Set(['appointment_confirm','appointment_deposit_pending','appointment_deposit_retained','appointment_changed','appointment_cancelled','appointment_reminder']);
export async function resolveAppointmentSender(tenant: TenantContext, kind: string): Promise<{from?:string;replyTo:string|null}> {
  if (!APPOINTMENTS.has(kind)) return {replyTo:null};
  const [s] = await withTenant(tenant, tx=>tx<{
    use_custom:boolean;from_local:string;reply_to:string|null;domain:string|null;status:string|null;
  }[]>`select s.use_custom,s.from_local,s.reply_to,d.domain,d.status from email_sender_settings s
       left join email_domain_requests d on d.id=s.domain_request_id and d.org_id=s.org_id and d.location_id=s.location_id
       where s.location_id=${tenant.locationId}`);
  if (!s) return {replyTo:null};
  if (s.use_custom && s.domain && s.status==='verified' && ['elasticemail','maileroo'].includes(emailProvider())) {
    try {
      if (!isCaptureMode() && process.env['NODE_ENV']!=='test') {
        if (emailProvider() === 'maileroo') {
          if (!(await mailerooDomain(s.domain))?.status) return {replyTo:s.reply_to};
        } else {
          const d=await elasticRequest<ElasticDomain>('GET',`/domains/${encodeURIComponent(s.domain)}`,undefined,undefined,3500);
          if (!elasticDomainReady(d)) return {replyTo:s.reply_to};
        }
      }
      return {from:`${s.from_local}@${s.domain}`,replyTo:s.reply_to};
    } catch { /* A verified platform sender remains the safe booking fallback. */ }
  }
  return {replyTo:s.reply_to};
}
