import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '@gf/contracts';

const mocks = vi.hoisted(() => ({
  checkout: vi.fn(), charge: vi.fn(), customer: vi.fn(), dispatch: vi.fn(),
}));
vi.mock('@gf/db', () => ({
  withTenant: vi.fn(async () => [{ stripe_customer_id: 'cus_topup' }]),
}));
vi.mock('../bus', () => ({ dispatch: mocks.dispatch, registerHandler: vi.fn() }));
vi.mock('../handlers/billing', () => ({}));
vi.mock('./client', async (original) => ({
  ...await original<typeof import('./client')>(),
  stripeClient: () => ({
    checkout: { sessions: { create: mocks.checkout } },
    paymentIntents: { create: mocks.charge },
    customers: { retrieve: mocks.customer },
  }),
}));
import { registerStripeRoutes } from './routes';

const ctx: CommandContext = {
  orgId: 'org_topup', locationId: 'loc_topup', membershipId: 'member_topup',
  userId: 'user_topup', actorKind: 'user', locale: 'en', timezone: 'America/New_York',
  permissions: new Set(['billing.manage']),
};
let app: ReturnType<typeof Fastify>;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.customer.mockResolvedValue({ id: 'cus_topup', metadata: { gf_org_id: ctx.orgId } });
  mocks.checkout.mockResolvedValue({ id: 'cs_topup', url: 'https://checkout.stripe.com/c/pay/cs_topup' });
  app = Fastify();
  registerStripeRoutes(app, async () => ctx);
});
afterEach(async () => { await app.close(); });

describe('manual topup Checkout', () => {
  it.each([['credit', 1000], ['voice_minute', 200]])('requires hosted payment confirmation for %s', async (unit, units) => {
    const response = await app.inject({
      method: 'POST', url: '/v1/billing/topup',
      payload: { unit, successUrl: '/settings?tab=billing', cancelUrl: '/settings?tab=billing' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ sessionId: 'cs_topup', url: 'https://checkout.stripe.com/c/pay/cs_topup' });
    expect(mocks.checkout).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'payment', customer: 'cus_topup',
      success_url: expect.stringContaining('/settings?tab=billing'),
      cancel_url: expect.stringContaining('/settings?tab=billing'),
      line_items: [expect.objectContaining({ quantity: 1, price_data: expect.objectContaining({ currency: 'usd', unit_amount: 5000 }) })],
      payment_intent_data: { metadata: {
        gf_org_id: ctx.orgId, gf_location_id: ctx.locationId,
        gf_kind: 'topup', gf_unit: unit, gf_units: String(units),
      } },
    }));
    expect(mocks.charge).not.toHaveBeenCalled();
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it('rejects an invalid quota before creating a payment session', async () => {
    const response = await app.inject({ method: 'POST', url: '/v1/billing/topup', payload: { unit: 'money' } });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(mocks.checkout).not.toHaveBeenCalled();
    expect(mocks.charge).not.toHaveBeenCalled();
  });

  it('does not charge or grant quota if Stripe session creation fails', async () => {
    mocks.checkout.mockRejectedValueOnce(new Error('stripe_unavailable'));
    const response = await app.inject({ method: 'POST', url: '/v1/billing/topup', payload: { unit: 'credit' } });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(mocks.charge).not.toHaveBeenCalled();
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });
});
