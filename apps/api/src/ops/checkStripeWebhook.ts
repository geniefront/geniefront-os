/** Check production event coverage before deployment; --apply adds missing events. */
import { stripeClient, type Stripe } from '../stripe/client';

const required: Stripe.WebhookEndpointUpdateParams.EnabledEvent[] = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.trial_will_end',
  'invoice.paid',
  'invoice.payment_succeeded',
  'invoice.payment_failed',
  'payment_method.detached',
  'charge.refunded',
  'charge.dispute.created',
];
const host = process.env['API_HOST'];
if (!host) throw new Error('API_HOST is required');
const url = `https://${host}/v1/stripe/webhook`;
const stripe = stripeClient();
const endpoints = [];
for await (const endpoint of stripe.webhookEndpoints.list({ limit: 100 })) {
  if (endpoint.url === url && endpoint.status === 'enabled') endpoints.push(endpoint);
}
if (endpoints.length !== 1) throw new Error(`Expected one enabled Stripe webhook for ${url}, found ${endpoints.length}`);
const endpoint = endpoints[0]!;
const missing = endpoint.enabled_events.includes('*')
  ? [] : required.filter(event => !endpoint.enabled_events.includes(event));
if (missing.length && process.argv.includes('--apply')) {
  await stripe.webhookEndpoints.update(endpoint.id, {
    enabled_events: [...new Set([...endpoint.enabled_events, ...missing])] as Stripe.WebhookEndpointUpdateParams.EnabledEvent[],
  });
  const verified = await stripe.webhookEndpoints.retrieve(endpoint.id);
  if (required.some(event => !verified.enabled_events.includes(event))) throw new Error('Stripe webhook verification failed');
  console.log(`Stripe webhook coverage repaired: ${missing.join(', ')}`);
} else if (missing.length) {
  throw new Error(`Stripe webhook missing events: ${missing.join(', ')}. Run this script with --apply using the target environment.`);
} else {
  console.log('Stripe webhook event coverage OK');
}
