/**
 * AI 副驾自己的命令（Phase 2，05 §6 / §7.3）
 *
 * 只有一条，而且是内部的：**记一次副驾调用的用量并扣余额**。
 *
 * 为什么要走命令而不是在路由里直接写库：用量落 `usage_events` 和
 * 扣 `credit_ledger` **必须在同一个事务里**（billing/usage.ts 顶部的长注释），
 * 而事务的边界就是命令。顺带还白拿了审计和 RLS。
 *
 * `exposed: false` —— 副驾**不能提议给自己记账**。让模型有能力
 * 往账本里写东西，哪怕只是记它自己的用量，都是一条不该开的口子。
 */

import { z } from 'zod';
import { defineCommand, cents } from '../command.js';

export const RecordAiAssist = defineCommand({
  name: 'ai.recordAssist',
  input: z.object({
    /** desk_copilot | price_list_vision | … 出成本报表时按它分组 */
    feature: z.string().min(1).max(40),
    model: z.string().min(1).max(60),
    /** 总 token 数（输入 + 输出 + 缓存读写），口径见 05 §7.3 */
    tokens: z.number().int().min(0),
    /**
     * ⚠️ 单位是**毫分**（1/1000 分），不是分。
     *
     * 一次副驾调用大约 1.2 分 = 1200 毫分。传成 12000 的话账单差 10 倍，
     * 而这是最难被发现的一类错 —— 数字看起来完全正常。
     */
    costMillicents: z.number().int().min(0),
    /** 走了几轮工具。用来在报表里看有没有一类问题总在绕圈 */
    rounds: z.number().int().min(1).max(10).default(1),
    hadProposal: z.boolean().default(false),
  }),
  output: z.object({
    usageEventId: z.string().uuid(),
    /** 从余额里扣了多少分。0 = 舍入后不足一分 */
    chargedCents: cents.min(0),
    /** 扣完之后的余额。**可以是负数**（见 @gf/payroll 的 credits.ts） */
    balanceAfterCents: cents.nullable(),
  }),
  permission: 'ai.use',
  ai: {
    description: '（内部）记一次副驾调用的用量。',
    confirm: 'never',
    // 副驾不能提议给自己记账
    exposed: false,
  },
  reversible: false,
  idempotency: 'optional',
});

export const AI_COMMANDS = [RecordAiAssist] as const;
