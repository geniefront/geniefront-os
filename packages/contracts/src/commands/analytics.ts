/**
 * 经营分析写命令。
 *
 * 外部模型生成必须在事务外完成。这里只持久化已经生成好的摘要，
 * 让审计、权限、订阅冻结走命令总线。
 */

import { z } from 'zod';
import { defineCommand, uuid } from '../command.js';

export const businessSummaryContentSchema = z.object({
  highlights: z.array(z.string().min(3).max(240)).min(1).max(5),
  risks: z.array(z.string().min(3).max(240)).max(5),
  actions: z.array(z.string().min(3).max(240)).min(1).max(5),
});

export const SaveBusinessSummary = defineCommand({
  name: 'analytics.saveBusinessSummary',
  input: z.object({
    periodStart: z.string().min(8).max(32),
    periodEnd: z.string().min(8).max(32),
    generator: z.string().min(1).max(40),
    generatorVersion: z.string().min(1).max(60),
    inputFactsSha256: z.string().regex(/^[0-9a-f]{64}$/),
    inputRecordCount: z.number().int().min(0),
    content: businessSummaryContentSchema,
  }),
  output: z.object({
    summaryId: uuid,
    generatedAt: z.string(),
    highlights: z.array(z.string()),
    risks: z.array(z.string()),
    actions: z.array(z.string()),
  }),
  permission: 'report.view',
  ai: {
    description: '（内部）把已经生成好的经营摘要写入本店缓存。',
    confirm: 'never',
    exposed: false,
  },
  reversible: false,
  /**
   * Same facts hash is already unique per location+generator. A new generate
   * click is intentionally a new generation when facts changed; retries of
   * the same hash reuse the unique row. No client idempotency key is sent
   * today, so we do not require one.
   */
  idempotency: 'optional',
});

export const ANALYTICS_COMMANDS = [SaveBusinessSummary] as const;
