import type postgres from 'postgres';
import type { CommandContext } from '@gf/contracts';
/** Read-only, tenant-scoped history. Provider acceptance is not delivery confirmation. */
export async function loadDeliveryLog(tx: postgres.TransactionSql, ctx: CommandContext) {
  return tx`
    select id,channel,recipient,subject,body,status,delivery_state,created_at,sent_at from (
      select id,'sms'::text channel,to_e164 recipient,
        case when entity_type='phone_call' then 'AI call summary' else kind end subject,
        body,status,null::text delivery_state,created_at,sent_at
      from sms_outbox where location_id=${ctx.locationId} and created_at>now()-interval '90 days'
      union all
      select id,'email'::text channel,to_email recipient,subject,body_text body,
        status,delivery_state,created_at,sent_at
      from email_outbox where location_id=${ctx.locationId} and created_at>now()-interval '90 days'
    ) records order by created_at desc,id desc limit 200`;
}
