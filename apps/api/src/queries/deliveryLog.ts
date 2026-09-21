import type postgres from 'postgres';
import type { CommandContext } from '@gf/contracts';
/** Read-only, tenant-scoped history. Provider acceptance is not delivery confirmation. */
export async function loadDeliveryLog(tx: postgres.TransactionSql, ctx: CommandContext, opts: { offset?: number; q?: string; channel?: string } = {}) {
  return tx`
    select *, count(*) over()::int as total from (
      select id,'sms'::text channel,to_e164 recipient,
        case when entity_type='phone_call' then 'AI call summary' else kind end subject,
        body,status,delivery_state,delivery_at,created_at,sent_at,last_error,attempts,entity_type,entity_id
      from sms_outbox where location_id=${ctx.locationId}
      union all
      select id,'email'::text channel,to_email recipient,subject,body_text body,
        status,delivery_state,delivery_at,created_at,sent_at,last_error,attempts,entity_type,entity_id
      from email_outbox where location_id=${ctx.locationId}
     ) records where (${opts.channel ?? 'all'}='all' or channel=${opts.channel ?? 'all'})
      and (${opts.q ?? ''}='' or concat_ws(' ',recipient,subject,body) ilike ${'%' + (opts.q ?? '') + '%'})
      order by created_at desc,id desc limit 100 offset ${Math.max(0, Math.floor(opts.offset ?? 0))}`;
}
