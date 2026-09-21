import { z } from 'zod';
import { AppError, ERROR_CODES } from '@gf/contracts';
import { withUser } from '@gf/db';
import type { PlatformOperator } from './auth';
import { stripeClient } from '../stripe/client';
import { assertStripeCustomerBelongsTo } from '../stripe/routes';

const inputSchema = z.object({
  previousMembershipId: z.string().uuid(),
  newOwnerEmail: z.string().trim().toLowerCase().email().max(320),
  reason: z.string().trim().min(3).max(1000),
  acknowledgePaymentMethod: z.literal(true),
}).strict();
type Transfer = {
  id: string; location_id: string; org_id: string; new_email: string;
  new_user_id: string; stripe_customer_id: string | null; state: 'pending' | 'completed';
};
const reasons = new Set(['owner_changed', 'multiple_owners', 'org_owner_requires_scoped_transfer',
  'new_owner_must_verify_email', 'same_owner', 'shared_stripe_customer', 'transfer_pending', 'transfer_key_reused']);

export async function transferStoreOwner(operator: PlatformOperator, locationId: string, raw: unknown, key: string) {
  if (operator.role !== 'super_admin') throw new AppError(ERROR_CODES.PERMISSION_DENIED);
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) throw new AppError(ERROR_CODES.VALIDATION_FAILED, { details: { issues: parsed.error.issues } });
  const input = parsed.data;
  try {
    const [row] = await withUser(operator.userId, tx => tx<{ transfer: Transfer }[]>`
      select gf_private.prepare_owner_transfer(${locationId}::uuid, ${input.previousMembershipId}::uuid,
        ${input.newOwnerEmail}, ${input.reason}, ${key}) as transfer`);
    const transfer = row!.transfer;
    if (transfer.state !== 'completed') {
      if (transfer.stripe_customer_id) {
        const stripe = stripeClient();
        await assertStripeCustomerBelongsTo(transfer.stripe_customer_id, { orgId: transfer.org_id, locationId: transfer.location_id });
        // Preserve subscriptions, cards and historical invoices. Retrying an intent
        // uses the same Stripe key and the durable pending transfer, never a new grant.
        await stripe.customers.update(transfer.stripe_customer_id, { email: transfer.new_email },
          { idempotencyKey: `owner-transfer:${transfer.id}` });
      }
      await withUser(operator.userId, tx => tx`select gf_private.complete_owner_transfer(${transfer.id}::uuid)`);
    }
    return { transferred: true, transferId: transfer.id, newOwnerEmail: transfer.new_email,
      stripeEmailSynced: !!transfer.stripe_customer_id, paymentMethodRetained: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (reasons.has(message)) throw new AppError(ERROR_CODES.VALIDATION_FAILED, { details: { reason: message } });
    throw error;
  }
}
