/**
 * 双向短信写命令（sql/0034，P0 核心业务）
 *
 * 包含：
 *   - sms.sendDirect: 前台主动向客户发送/回复短信
 */

import { z } from 'zod';
import { defineCommand, uuid, phoneE164 } from '../command.js';

export const smsSendDirectInput = z.object({
  toE164: phoneE164,
  body: z.string().trim().min(1, '短信正文不能为空').max(1600, '短信正文不能超过 1600 字符'),
  customerId: uuid.optional(),
  mediaUrls: z.array(z.string().url()).optional(),
});
export type SmsSendDirectInput = z.infer<typeof smsSendDirectInput>;

export const smsSendDirectOutput = z.object({
  outboxId: uuid,
  segments: z.number().int().min(1),
  status: z.enum(['pending', 'sent', 'suppressed', 'failed']),
});
export type SmsSendDirectOutput = z.infer<typeof smsSendDirectOutput>;

export const smsSendDirect = defineCommand({
  name: 'sms.sendDirect',
  input: smsSendDirectInput,
  output: smsSendDirectOutput,
  permission: 'comms.send',
  ai: {
    description: '向前台客人或指定手机号直接发送短信或回复',
    confirm: 'never',
  },
  reversible: false,
  idempotency: 'optional',
});

export const SMS_COMMANDS = [
  smsSendDirect,
] as const;
