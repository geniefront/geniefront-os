import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';
import { closeDb, withTenant } from '@gf/db';
import { buildServer } from './server';
import { flushEmails } from './email/flush';
import { mailerooReferenceId } from './email/maileroo';
const tenant = { orgId: '11111111-1111-4111-8111-111111111111', locationId: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', membershipId: null };
const other = { orgId: '22222222-2222-4222-8222-222222222222', locationId: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', membershipId: null };
let app: ReturnType<typeof buildServer>;
beforeAll(async () => { app = buildServer(); await app.ready(); });
afterAll(async () => { await app.close(); await closeDb(); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
async function row() {
  const id = randomUUID(), email = `maileroo-${id}@example.com`;
  await withTenant(tenant, tx => tx`insert into email_outbox(id,org_id,location_id,kind,to_email,subject,body_html,body_text,entity_type,entity_id,provider,provider_id)
    values(${id},${tenant.orgId},${tenant.locationId},'appointment_confirm',${email},'Booking','html','text','maileroo_test',${id},'maileroo',${mailerooReferenceId(id)})`);
  return { id, email };
}
async function hook(id: string, email: string, type: string, context = tenant, reason?: string) {
  vi.stubEnv('MAILEROO_WEBHOOK_SECRET', 'test-signing-secret');
  const raw = JSON.stringify({ event_id: randomUUID(), event_type: type, message_reference_id: mailerooReferenceId(id),
    tags: [{name:'org_id',value:context.orgId},{name:'location_id',value:context.locationId},{name:'outbox_id',value:id}], event_data: { to: email, reason } }, null, 2);
  return app.inject({ method: 'POST', url: '/v1/webhooks/maileroo', payload: raw, headers: {
    'content-type': 'application/json', 'x-maileroo-signature': createHmac('sha256','test-signing-secret').update(raw).digest('hex'),
  } });
}
describe('Maileroo outbox and signed callbacks', () => {
  it('accepts authenticated provider callbacks without a user login and ignores reordering', async () => {
    const {id,email} = await row();
    expect((await hook(id,email,'delivered')).statusCode).toBe(200);
    expect((await hook(id,email,'deferred')).statusCode).toBe(200);
    const [r] = await withTenant(tenant, tx => tx`select delivery_state from email_outbox where id=${id}`);
    expect(r?.delivery_state).toBe('delivered');
  });
  it('rejects forged callbacks and never writes across tenants or recipients', async () => {
    const {id,email} = await row();
    expect((await app.inject({method:'POST',url:'/v1/webhooks/maileroo',payload:{}})).statusCode).toBe(401);
    await hook(id,email,'complained',other);
    await hook(id,'someone-else@example.com','complained');
    const [r] = await withTenant(tenant, tx => tx`select delivery_state from email_outbox where id=${id}`);
    expect(r?.delivery_state).toBeNull();
  });
  it('keeps soft failures retry-safe but persists hard-bounce suppression', async () => {
    const {id,email} = await row();
    await hook(id,email,'failed',tenant,'452 4.2.2 Mailbox full');
    expect(await withTenant(tenant,tx=>tx`select email from email_suppressions where email=${email}`)).toHaveLength(0);
    await hook(id,email,'failed',tenant,'550 5.1.1 User unknown');
    expect(await withTenant(tenant,tx=>tx`select email from email_suppressions where email=${email}`)).toHaveLength(1);
  });
  it('receives delivery before the send response without losing correlation', async () => {
    await withTenant(tenant,tx=>tx`update email_outbox set status='failed' where status='pending'`);
    const {id,email} = await row();
    vi.stubEnv('NODE_ENV','production'); vi.stubEnv('GF_ENV','production'); vi.stubEnv('EMAIL_PROVIDER','maileroo');
    vi.stubEnv('MAILEROO_API_KEY','mock-sending-key'); vi.stubEnv('FROM_EMAIL','GenieFront <noreply@notify.geniefront.com>');
    vi.stubEnv('COMMUNICATION_DELIVERY_MODE','live');
    const network = vi.fn(async (_url: unknown, opts: RequestInit) => {
      const body = JSON.parse(String(opts.body));
      expect(body.tags.outbox_id).toBe(id);
      expect((await hook(id,email,'delivered')).statusCode).toBe(200);
      return new Response(JSON.stringify({ success:true,data:{reference_id:body.reference_id} }));
    });
    vi.stubGlobal('fetch',network);
    await flushEmails(tenant);
    const [r] = await withTenant(tenant,tx=>tx`select status,delivery_state,provider_id from email_outbox where id=${id}`);
    expect(r).toMatchObject({status:'sent',delivery_state:'delivered',provider_id:mailerooReferenceId(id)});
    expect(network).toHaveBeenCalledTimes(1);
  });
  it('quarantines a network timeout and never blindly sends the same message again', async () => {
    const {id} = await row();
    vi.stubEnv('NODE_ENV','production'); vi.stubEnv('GF_ENV','production'); vi.stubEnv('EMAIL_PROVIDER','maileroo');
    vi.stubEnv('MAILEROO_API_KEY','mock-sending-key'); vi.stubEnv('FROM_EMAIL','noreply@notify.geniefront.com');
    vi.stubEnv('COMMUNICATION_DELIVERY_MODE','live');
    const network = vi.fn().mockRejectedValue(new Error('timeout')); vi.stubGlobal('fetch',network);
    await flushEmails(tenant); await flushEmails(tenant);
    const [r] = await withTenant(tenant,tx=>tx`select status,provider_id from email_outbox where id=${id}`);
    expect(r).toMatchObject({status:'uncertain',provider_id:mailerooReferenceId(id)});
    expect(network).toHaveBeenCalledTimes(1);
  });
});
