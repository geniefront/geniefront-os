import { SaveBookingPolicy, AppError, ERROR_CODES } from '@gf/contracts';
import { jsonb } from '@gf/db';
import { registerHandler } from '../bus';
import { lockBookingCapacity } from './appointment';

registerHandler(SaveBookingPolicy, async ({ input, ctx, tx, audit }) => {
  const [account] = await tx<{ plan: string }[]>`select plan from billing_accounts where location_id=${ctx.locationId}`;
  await lockBookingCapacity(tx, ctx.locationId);
  const [row] = await tx<{ settings: Record<string, unknown> }[]>`
    select settings from locations where id = ${ctx.locationId} for update`;
  if (!row) throw new AppError(ERROR_CODES.NOT_FOUND);
  const before = (row.settings.capacity ?? {}) as Record<string, unknown>;
  const after = {
    ...before, ...(account?.plan==='voice_booking'?{use_recurring_staff:true,strict_staff:true}:{}), booking_mode: input.mode, max_concurrent_per_slot: input.baseCapacity,
    buffer_enabled: input.bufferEnabled, buffer_extra: input.bufferExtra,
    request_buffer_enabled: input.requestBufferEnabled, request_buffer_extra: input.requestBufferExtra,
  };
  await tx`update locations set settings = jsonb_set(settings, '{capacity}', ${jsonb(after)}::jsonb),
    updated_at = now() where id = ${ctx.locationId}`;
  audit({ entityType: 'location', entityId: ctx.locationId, before, after });
  return { locationId: ctx.locationId };
});
