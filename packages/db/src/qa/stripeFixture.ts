/**
 * TEST-ONLY Stripe-state fixture.
 *
 * Writes the same billing_accounts columns that `billing.syncSubscription`
 * writes after a signed webhook. Does not call Stripe. Does not insert
 * billing_invoices or receipt URLs. Purchased balances go through
 * applyRecordedTopupFixture, which matches `billing.recordTopup`.
 *
 * Stripe ids are namespaced `cus_qa_*` / `sub_qa_*` / `pi_qa_*` so they
 * cannot be confused with a live Checkout object.
 */

import { PLAN_QUOTAS, TOPUP_PRICE_CENTS, TRIAL_DAYS, TRIAL_QUOTA, unitsPerTopup, type Plan, type QuotaUnit } from '@gf/payroll';
import type postgres from 'postgres';
import { futureTrialEnd, iso, periodEnd, type QaClock } from './clock';
import type { CanonicalPlan, SubscriptionStatus } from './types';

export type StripeSyncFixture = {
  orgId: string;
  locationId: string;
  plan: CanonicalPlan;
  subscriptionStatus: SubscriptionStatus;
  trialDays?: number;
  clock: QaClock;
  scenarioKey: string;
};

export function quotaFor(plan: CanonicalPlan, trialing: boolean): { credits: number; voiceMinutes: number } {
  return trialing ? TRIAL_QUOTA : PLAN_QUOTAS[plan as Plan];
}

export async function applyStripeSyncFixture(
  tx: postgres.TransactionSql,
  args: StripeSyncFixture,
): Promise<void> {
  const trialing = args.subscriptionStatus === 'trialing';
  const trialEndsAt = trialing
    ? iso(futureTrialEnd(args.clock, args.trialDays ?? TRIAL_DAYS))
    : null;
  const currentPeriodEnd = iso(periodEnd(args.clock, trialing ? (args.trialDays ?? TRIAL_DAYS) : 30));
  const customerId = `cus_qa_${args.scenarioKey.replace(/[^a-z0-9]/gi, '').slice(0, 24)}`;
  const subscriptionId = `sub_qa_${args.scenarioKey.replace(/[^a-z0-9]/gi, '').slice(0, 24)}`;

  await tx`
    insert into billing_accounts (
      org_id, location_id, stripe_customer_id, stripe_subscription_id,
      plan, subscription_status, current_period_end, trial_ends_at,
      included_credits_used, included_minutes_used
    ) values (
      ${args.orgId}, ${args.locationId}, ${customerId}, ${subscriptionId},
      ${args.plan}, ${args.subscriptionStatus},
      ${currentPeriodEnd}::timestamptz,
      ${trialEndsAt}::timestamptz,
      0, 0
    )
    on conflict (location_id) do update set
      stripe_customer_id = excluded.stripe_customer_id,
      stripe_subscription_id = excluded.stripe_subscription_id,
      plan = excluded.plan,
      subscription_status = excluded.subscription_status,
      current_period_end = excluded.current_period_end,
      trial_ends_at = excluded.trial_ends_at,
      included_credits_used = 0,
      included_minutes_used = 0`;
}

/**
 * Equivalent to `billing.recordTopup` after a succeeded PaymentIntent.
 * Uses the canonical $50 pack sizes. Never used as a shortcut for
 * billing.buyAddon / billing.changePlan.
 */
export async function applyRecordedTopupFixture(
  tx: postgres.TransactionSql,
  args: {
    orgId: string;
    locationId: string;
    unit: QuotaUnit;
    scenarioKey: string;
  },
): Promise<void> {
  const units = unitsPerTopup(args.unit);
  const col = args.unit === 'credit' ? 'credit_balance' : 'voice_minute_balance';
  const pi = `pi_qa_${args.scenarioKey}_${args.unit}`.replace(/[^a-z0-9_]/gi, '').slice(0, 80);

  const [acct] = await tx<{ id: string; credit_balance: number; voice_minute_balance: number }[]>`
    select id, credit_balance, voice_minute_balance from billing_accounts
    where location_id = ${args.locationId} for update`;
  if (!acct) throw new Error('applyRecordedTopupFixture requires billing.syncSubscription fixture first');

  const before = args.unit === 'credit' ? acct.credit_balance : acct.voice_minute_balance;
  const after = before + units;

  await tx`
    insert into credit_ledger
      (org_id, location_id, kind, unit, amount, balance_after, paid_cents,
       amount_cents, balance_after_cents, source, stripe_payment_intent_id, reason)
    values (
      ${args.orgId}, ${args.locationId}, 'topup', ${args.unit},
      ${units}, ${after}, ${TOPUP_PRICE_CENTS},
      null, null, 'qa_stripe_fixture', ${pi}, null
    )`;
  await tx`update billing_accounts set ${tx(col)} = ${after} where id = ${acct.id}`;
}

/**
 * Same columns as `billing.savePaymentMethod` after Stripe Checkout attached a
 * default payment method. Namespaced `pm_qa_*` so it cannot be confused with a
 * live PaymentMethod. Never used as a shortcut for billing.changePlan.
 */
export async function applySavedPaymentMethodFixture(
  tx: postgres.TransactionSql,
  args: {
    locationId: string;
    scenarioKey: string;
    label?: string;
  },
): Promise<void> {
  const paymentMethodId = `pm_qa_${args.scenarioKey.replace(/[^a-z0-9]/gi, '').slice(0, 24)}`;
  await tx`
    update billing_accounts set
      default_payment_method_id = ${paymentMethodId},
      payment_method_label = ${args.label ?? 'Visa ···· 4242'}
    where location_id = ${args.locationId}`;
}
