import { afterAll, describe, expect, it } from 'vitest';
import { closeDb, withTenant } from '@gf/db';
import { claimStripeEvent } from '../stripe/routes';

const tenant = {
  orgId: '22222222-2222-4222-8222-222222222222',
  locationId: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
};

const event = (suffix: string) => ({
  id: `evt_test_lease_${suffix}`,
  type: 'customer.subscription.updated' as const,
});

afterAll(async () => closeDb());

describe('Stripe webhook processing lease', () => {
  it('fresh event is claimed once while its lease is active', async () => {
    const e = event('fresh');
    expect(await claimStripeEvent(e, tenant)).toBe(true);
    expect(await claimStripeEvent(e, tenant)).toBe(false);
  });

  it('stale processing event can be reclaimed after a worker crash', async () => {
    const e = event('stale');
    expect(await claimStripeEvent(e, tenant)).toBe(true);
    await withTenant({ ...tenant, membershipId: null }, (tx) => tx`
      update stripe_events
      set attempt_started_at = now() - interval '11 minutes'
      where id = ${e.id}`);
    expect(await claimStripeEvent(e, tenant)).toBe(true);
  });

  it('processed event is never reclaimed', async () => {
    const e = event('processed');
    expect(await claimStripeEvent(e, tenant)).toBe(true);
    await withTenant({ ...tenant, membershipId: null }, (tx) => tx`
      update stripe_events set status = 'processed', processed_at = now()
      where id = ${e.id}`);
    expect(await claimStripeEvent(e, tenant)).toBe(false);
  });
});
