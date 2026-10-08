import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ retrieve: vi.fn(), dispatch: vi.fn(), query: vi.fn() }));
vi.mock('@gf/db', () => ({
  withTenant: vi.fn(async (_ctx, fn) => fn(mocks.query)),
  findBillingTenantByStripeRefs: vi.fn(),
}));
vi.mock('../bus', () => ({ dispatch: mocks.dispatch, registerHandler: vi.fn() }));
vi.mock('../handlers/billing', () => ({}));
vi.mock('./client', async (original) => ({
  ...await original<typeof import('./client')>(),
  stripeClient: () => ({ subscriptions: { retrieve: mocks.retrieve } }),
}));
import { registerStripeRoutes } from './routes';
import { registerRawBodyParser } from '../rawBody';
import { signStripePayload } from './verify';

const metadata = { gf_org_id: '92203dc9-8c2d-4bdb-9e30-55893b52a8a5', gf_location_id: '1c708a61-b467-4062-af96-2cd6392e20e5' };
const secret = 'whsec_invoice_sync_test';
let app: ReturnType<typeof Fastify>;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('STRIPE_WEBHOOK_SECRET', secret);
  mocks.query.mockResolvedValue([{ id: 'evt_paid' }]);
  mocks.dispatch.mockResolvedValue({ result: { invoiceId: 'invoice_local' } });
  mocks.retrieve.mockResolvedValue({
    id: 'sub_paid', customer: 'cus_paid', status: 'active',
    trial_end: 1791313535, items: { data: [{ id: 'si_paid', current_period_end: 1793991935 }] },
    default_payment_method: { id: 'pm_paid', type: 'card', card: { brand: 'mastercard', last4: '2190' } },
  });
  app = Fastify();
  registerRawBodyParser(app);
  registerStripeRoutes(app, async () => { throw new Error('Webhook must not use user auth'); });
});
afterEach(async () => { await app.close(); vi.unstubAllEnvs(); });
async function post(type = 'invoice.paid', refs: Record<string, unknown> = { parent: { subscription_details: { subscription: 'sub_paid' } } }) {
  const raw = JSON.stringify({ id: 'evt_paid', type, data: { object: {
    id: 'in_paid', object: 'invoice', metadata, customer: 'cus_paid',
    amount_paid: 9900, created: 1791313535, period_start: 1791313535, period_end: 1793991935, ...refs,
  } } });
  return app.inject({ method: 'POST', url: '/v1/stripe/webhook', payload: raw,
    headers: { 'content-type': 'application/json', 'stripe-signature': signStripePayload(raw, secret, Math.floor(Date.now() / 1000)) } });
}
describe('paid invoice subscription recovery', () => {
  it.each(['invoice.paid', 'invoice.payment_succeeded'])('%s synchronizes Stripe status and period before recording the invoice', async (type) => {
    expect((await post(type)).statusCode).toBe(200);
    expect(mocks.retrieve).toHaveBeenCalledWith('sub_paid');
    expect(mocks.dispatch.mock.calls[0]).toEqual([
      'billing.syncSubscription', expect.objectContaining({
        stripeSubscriptionId: 'sub_paid', subscriptionStatus: 'active',
        currentPeriodEnd: '2026-11-06T19:05:35.000Z', trialEndsAt: null,
      }), expect.objectContaining({ locationId: metadata.gf_location_id }), { systemOrigin: 'stripe_webhook' },
    ]);
    expect(mocks.dispatch).toHaveBeenCalledWith('billing.recordInvoice', expect.objectContaining({ amountCents: 9900 }), expect.anything(), expect.anything());
  });
  it('supports legacy invoice subscription references', async () => {
    expect((await post('invoice.paid', { subscription: 'sub_paid' })).statusCode).toBe(200);
    expect(mocks.retrieve).toHaveBeenCalledWith('sub_paid');
  });
  it('does not activate a canceled subscription when an old invoice is replayed', async () => {
    mocks.retrieve.mockResolvedValueOnce({ ...(await mocks.retrieve()), status: 'canceled' });
    await post();
    expect(mocks.dispatch).toHaveBeenCalledWith('billing.syncSubscription', expect.objectContaining({ subscriptionStatus: 'canceled', trialEndsAt: null }), expect.anything(), expect.anything());
  });
  it('keeps actual trialing subscriptions in trial on zero-dollar invoices', async () => {
    mocks.retrieve.mockResolvedValueOnce({ ...(await mocks.retrieve()), status: 'trialing' });
    await post('invoice.paid', { subscription: 'sub_paid', amount_paid: 0 });
    expect(mocks.dispatch).toHaveBeenCalledWith('billing.syncSubscription', expect.objectContaining({ subscriptionStatus: 'trialing', trialEndsAt: '2026-10-06T19:05:35.000Z' }), expect.anything(), expect.anything());
  });
  it('leaves standalone invoices independent of subscription state', async () => {
    expect((await post('invoice.paid', {})).statusCode).toBe(200);
    expect(mocks.retrieve).not.toHaveBeenCalled();
    expect(mocks.dispatch.mock.calls.map(c => c[0])).toEqual(['billing.recordInvoice']);
  });
  it('fails for retry if Stripe cannot be retrieved instead of acknowledging stale billing', async () => {
    mocks.retrieve.mockRejectedValueOnce(new Error('stripe_unavailable'));
    expect((await post()).statusCode).toBe(500);
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(mocks.query.mock.calls.some(c => c[0].join('').includes("status = 'failed'"))).toBe(true);
  });
});
