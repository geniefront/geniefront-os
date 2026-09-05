/** Only authenticated provider API events can change delivery/suppression state. */
import { withTenant, type TenantContext } from '@gf/db';
import { elasticRequest } from './elastic';
export interface ElasticEvent { MsgID:string; TransactionID:string; To:string; EventType:string; EventDate:string; MessageCategory?:string; }
export function eventState(e:ElasticEvent): string|null {
  switch(e.EventType) {
    case 'Sent': case 'Open': case 'Click': return 'delivered';
    case 'FailedAttempt': return 'delayed';
    case 'Bounce': return e.MessageCategory==='NoMailbox'?'hard_bounce':'soft_bounce';
    case 'Error': case 'Suppress': return e.MessageCategory==='NoMailbox'?'hard_bounce':'soft_bounce';
    case 'Complaint':return 'complained';
    default:return null;
  }
}
export async function reconcileEmail(tenant:TenantContext, transactionId:string):Promise<void> {
  const events=await elasticRequest<ElasticEvent[]>('GET',`/events/${encodeURIComponent(transactionId)}`);
  for(const e of events) {
    if(!e.MsgID || !e.To || e.TransactionID!==transactionId) continue;
    await withTenant(tenant,async tx=>{
      const [r]=await tx<{id:string;to_email:string}[]>`select id,to_email from email_outbox
        where provider='elasticemail' and provider_account='main' and provider_transaction_id=${transactionId}
        and provider_id=${e.MsgID} and location_id=${tenant.locationId} for update`;
      if(!r || r.to_email.trim().toLowerCase()!==e.To.trim().toLowerCase()) return;
      const state=eventState(e);
      if(state) await tx`update email_outbox set delivery_state=${state},delivery_at=now()
        where id=${r.id} and (delivery_state is null
          or array_position(array['delayed','soft_bounce','delivered','hard_bounce','complained'],delivery_state)
             <=array_position(array['delayed','soft_bounce','delivered','hard_bounce','complained'],${state}))`;
      const all=['Complaint','Suppress','Unsubscribe'].includes(e.EventType) || state==='hard_bounce';
      const marketing=e.EventType==='TransactionalUnsubscribe';
      if(all || marketing) {
        await tx`insert into email_account_suppressions(provider_account,email,scope,reason)
          values('main',${e.To.toLowerCase()},${all?'all':'marketing'},${e.EventType})
          on conflict(provider_account,email,scope) do update set reason=excluded.reason,updated_at=now()`;
        // Preserve organization scope: a provider event must not change unrelated shops' customer rows.
        await tx`update customers set marketing_email_opt_in=false where org_id=${tenant.orgId} and lower(email)=${e.To.toLowerCase()}`;
      }
      if(state==='hard_bounce') await tx`insert into email_suppressions(email,reason,provider_id)
        values(${e.To.toLowerCase()},'hard_bounce',${e.MsgID}) on conflict(email) do nothing`;
    });
  }
  await withTenant(tenant,tx=>tx`update email_outbox set last_reconciled_at=now() where provider='elasticemail' and provider_transaction_id=${transactionId}`);
}
