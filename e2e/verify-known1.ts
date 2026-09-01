import postgres from '../packages/db/node_modules/postgres/src/index.js';
import Stripe from '../apps/api/node_modules/stripe/esm/stripe.esm.node.js';
import { qaEnvironment } from './env';

if (!qaEnvironment.STRIPE_SECRET_KEY.startsWith('sk_test_')) {
  throw new Error('KNOWN-1 verification refuses a non-test Stripe key');
}

const sql = postgres(qaEnvironment.MIGRATION_DATABASE_URL, { max: 1 });
const stripe = new Stripe(qaEnvironment.STRIPE_SECRET_KEY);

try {
  const rows = await sql<{
    email: string;
    plan: string;
    subscription_status: string;
    stripe_subscription_id: string | null;
    default_payment_method_id: string | null;
  }[]>`
    select distinct u.email, ba.plan, ba.subscription_status,
      ba.stripe_subscription_id, ba.default_payment_method_id
    from billing_accounts ba
    join locations l on l.id = ba.location_id
    join memberships m on m.location_id = l.id
    join users u on u.id = m.user_id
    where u.email like 'gf-e2e-%@maildrop.cc'
    order by u.email
  `;

  const result = [];
  for (const row of rows) {
    let stripeDefaultPaymentMethod: string | null = null;
    if (row.stripe_subscription_id) {
      const subscription = await stripe.subscriptions.retrieve(row.stripe_subscription_id);
      stripeDefaultPaymentMethod = typeof subscription.default_payment_method === 'string'
        ? subscription.default_payment_method
        : subscription.default_payment_method?.id ?? null;
    }
    result.push({
      email: row.email,
      plan: row.plan,
      status: row.subscription_status,
      subscriptionId: row.stripe_subscription_id,
      localDefaultPaymentMethod: row.default_payment_method_id,
      stripeDefaultPaymentMethod,
      mismatch: Boolean(stripeDefaultPaymentMethod) && !row.default_payment_method_id,
    });
  }
  console.log(JSON.stringify(result, null, 2));
} finally {
  await sql.end();
}
