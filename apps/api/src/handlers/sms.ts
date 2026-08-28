/**
 * 主动发短信 / 回复短信命令处理器（sql/0034，P0 核心业务）
 */

import { randomUUID } from 'node:crypto';
import { smsSendDirect, AppError, ERROR_CODES } from '@gf/contracts';
import { smsOptedOut } from '@gf/db';
import { registerHandler } from '../bus';
import { segmentsOf } from '../sms/segments';
import { flushSms } from '../sms/flush';

registerHandler(smsSendDirect, async ({ input, ctx, tx, audit }) => {
  const fromE164 = process.env['TELNYX_SMS_FROM'] ?? '+18005550199';
  const segments = segmentsOf(input.body);
  const isOptedOut = await smsOptedOut(input.toE164);
  const status: 'suppressed' | 'pending' = isOptedOut ? 'suppressed' : 'pending';
  const entityId = input.customerId ?? randomUUID();

  const [outbox] = await tx<{ id: string }[]>`
    insert into sms_outbox (
      org_id, location_id, kind, to_e164, from_e164, body, segments,
      entity_type, entity_id, status, last_error
    ) values (
      ${ctx.orgId}, ${ctx.locationId}, 'direct_message', ${input.toE164},
      ${fromE164}, ${input.body}, ${segments}, 'customer', ${entityId},
      ${status}, ${isOptedOut ? 'opted_out' : null}
    )
    returning id`;

  audit({
    entityType: 'sms_outbox',
    entityId: outbox!.id,
    before: {},
    after: {
      toE164: input.toE164,
      segments,
      status,
      customerId: input.customerId ?? null,
    },
  });

  // 非阻断异步尝试投递
  if (status === 'pending') {
    void flushSms({
      orgId: ctx.orgId,
      locationId: ctx.locationId,
      membershipId: ctx.membershipId,
    });
  }

  return {
    outboxId: outbox!.id,
    segments,
    status,
  };
});
