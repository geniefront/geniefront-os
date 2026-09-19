import { createHash } from 'node:crypto';
import { stripeClient, priceIdFor } from './client';

/** Use a separate hosted portal so the special plan cannot purchase Essential. */
export async function voicePortalConfiguration(): Promise<string> {
  const stripe = stripeClient();
  const prices = await Promise.all((['voice_booking', 'growth'] as const).map(plan => stripe.prices.retrieve(priceIdFor(plan))));
  const products = new Map<string, string[]>();
  for (const price of prices) {
    const product = typeof price.product === 'string' ? price.product : price.product.id;
    products.set(product, [...(products.get(product) ?? []), price.id]);
  }
  const fingerprint = createHash('sha256').update(prices.map(p => p.id).join(':')).digest('hex').slice(0, 20);
  // Reuse across deploys and processes; Stripe also deduplicates concurrent creation.
  const existing = await stripe.billingPortal.configurations.list({ limit: 100, active: true });
  const found = existing.data.find(c => c.metadata?.gf_voice_policy === fingerprint);
  if (found) return found.id;
  const config = await stripe.billingPortal.configurations.create({
    metadata: { gf_voice_policy: fingerprint },
    features: {
      payment_method_update: { enabled: true }, invoice_history: { enabled: true },
      subscription_cancel: { enabled: true, mode: 'at_period_end' },
      subscription_update: { enabled: true, default_allowed_updates: ['price'],
        products: [...products].map(([product, ids]) => ({ product, prices: ids })),
        proration_behavior: 'create_prorations' },
    },
  }, { idempotencyKey: `gf-voice-portal-${fingerprint}` });
  return config.id;
}
