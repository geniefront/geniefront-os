/**
 * 主动发短信 / 回复短信命令处理器（sql/0034，P0 核心业务）。
 *
 * ⚠️ 入队逻辑统一在 `sms/direct.ts` —— 发件号、退订检查、分段计数与
 * 合规署名四项约束只允许有一份实现（见该文件头注释）。
 */

import { randomUUID } from 'node:crypto';
import { smsSendDirect } from '@gf/contracts';
import { registerHandler } from '../bus';
import { enqueueDirectSms } from '../sms/direct';
import { flushSms } from '../sms/flush';

registerHandler(smsSendDirect, async ({ input, ctx, tx, audit }) => {
  const res = await enqueueDirectSms(tx, {
    orgId: ctx.orgId,
    locationId: ctx.locationId,
    toE164: input.toE164,
    body: input.body,
    entityType: 'customer',
    // 散客没有 customerId：给一个一次性 uuid，避免多条消息共用同一个幂等键
    entityId: input.customerId ?? randomUUID(),
  });

  audit({
    entityType: 'sms_outbox',
    entityId: res.outboxId,
    before: {},
    after: {
      toE164: input.toE164,
      segments: res.segments,
      status: res.status,
      customerId: input.customerId ?? null,
    },
  });

  // 非阻断异步尝试投递
  if (res.status === 'pending') {
    void flushSms({
      orgId: ctx.orgId,
      locationId: ctx.locationId,
      membershipId: ctx.membershipId,
    });
  }

  return {
    outboxId: res.outboxId,
    segments: res.segments,
    status: res.status,
  };
});
