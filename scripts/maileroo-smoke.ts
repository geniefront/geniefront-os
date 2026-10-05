// Run with node --env-file=.env.staging --import tsx scripts/maileroo-smoke.ts <controlled-recipient>.
import { randomUUID } from 'node:crypto';
import { sql, withTenant, closeDb } from '../packages/db/src/index';
import { sendEmail } from '../apps/api/src/email/send';
import { mailerooReferenceId } from '../apps/api/src/email/maileroo';

if (process.env['GF_ENV'] !== 'staging' || process.env['EMAIL_PROVIDER'] !== 'maileroo') throw new Error('Staging Maileroo only');
const recipient = process.argv[2];
if (!recipient || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(recipient)) throw new Error('Explicit controlled recipient required');
const id = randomUUID();
try {
  const [r] = await sql<{ org_id: string; location_id: string }[]>`select * from gf_email_service_tenants(1)`;
  if (!r) throw new Error('No staging tenant available');
  const tenant = { orgId: r.org_id, locationId: r.location_id, membershipId: null };
  const subject = 'GenieFront Maileroo end-to-end migration check';
  const text = 'Controlled staging email transport test. No booking, customer record or marketing subscription is created.';
  await withTenant(tenant, tx => tx`insert into email_outbox(id,org_id,location_id,kind,to_email,subject,body_html,body_text,entity_type,entity_id,status,provider,provider_id,claimed_at)
    values(${id},${tenant.orgId},${tenant.locationId},'appointment_confirm',${recipient},${subject},${text},${text},'maileroo_migration_check',${id},'sending','maileroo',${mailerooReferenceId(id)},now())`);
  // Only this direct call sends; no pending queue is flushed and no scheduler is started.
  process.env['COMMUNICATION_DELIVERY_MODE'] = 'live';
  const result = await sendEmail({ to: recipient, subject, html: text, text, kind: 'appointment_confirm', outboxId: id, orgId: tenant.orgId, locationId: tenant.locationId });
  await withTenant(tenant, tx => tx`update email_outbox set status=${result.ok ? 'sent' : result.ambiguous ? 'uncertain' : 'failed'},last_error=${result.error ?? null},sent_at=case when ${result.ok} then now() else null end where id=${id}`);
  if (!result.ok) throw new Error(result.error || 'Send failed');
  console.log(JSON.stringify({ outboxId: id, reference: result.providerId, submission: 'accepted' }));
  for (let attempt = 0; attempt < 12; attempt++) {
    const [state] = await withTenant(tenant, tx => tx`select status,delivery_state from email_outbox where id=${id}`);
    if (state?.delivery_state === 'delivered') { console.log('PASS: application send -> Maileroo -> Fastmail -> signed webhook -> tenant outbox delivered'); break; }
    if (attempt === 11) throw new Error(`Delivery callback not confirmed: ${JSON.stringify(state)}`);
    await new Promise(resolve => setTimeout(resolve, 2500));
  }
} finally { await closeDb(); }
