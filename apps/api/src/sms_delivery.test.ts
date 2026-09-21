import { afterAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql, withTenant, closeDb } from '@gf/db';
import { loadDeliveryLog } from './queries/deliveryLog';
import type { CommandContext } from '@gf/contracts';
import { recordSmsDelivery } from './sms/delivery';
const tenant = { orgId: '11111111-1111-4111-8111-111111111111', locationId: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', membershipId: null };
afterAll(closeDb);
it('retains early final receipts and cannot regress on duplicate or out-of-order callbacks', async () => {
  const providerId = randomUUID();
  const payload = { direction: 'outbound', id: providerId, to: [{ status: 'delivered' }] };
  await recordSmsDelivery(payload, '2026-09-20T10:00:00Z');
  const [outbox] = await withTenant(tenant, tx => tx<{ id: string }[]>`
    insert into sms_outbox (org_id,location_id,kind,to_e164,from_e164,body,entity_type,entity_id,status,provider_id)
    values (${tenant.orgId},${tenant.locationId},'appointment_confirm','+16175550129','+16175550128','receipt test','appointment',${randomUUID()},'sent',${providerId}) returning id`);
  await recordSmsDelivery({ ...payload, to: [{ status: 'sent' }] }, '2026-09-20T11:00:00Z');
  await recordSmsDelivery({ ...payload, to: [{ status: 'delivery_failed' }] }, '2026-09-20T09:00:00Z');
  await recordSmsDelivery(payload, '2026-09-20T10:00:00Z');
  const [row] = await withTenant(tenant, tx => tx<{ status: string; delivery_state: string }[]>`select status,delivery_state from sms_outbox where id=${outbox!.id}`);
  expect(row).toMatchObject({ status: 'sent', delivery_state: 'delivered' });
  const history = await withTenant(tenant, tx => loadDeliveryLog(tx, tenant as unknown as CommandContext, { q: 'receipt test', channel: 'sms' }));
  expect(history).toHaveLength(1);
  expect(history[0]?.delivery_state).toBe('delivered');
  await expect(sql`select * from sms_delivery_receipts`).rejects.toThrow();
});
