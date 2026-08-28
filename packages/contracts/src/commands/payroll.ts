/**
 * 薪酬方案（Phase 1b）
 *
 * 方案是**版本化**的：改规则只影响之后的单，历史 earnings 一行不动。
 * 这不是技术洁癖 —— 技师每天下班看一次自己的收入，
 * 如果老板周三改了提成率、周一的数字跟着变了，这个系统就再也没人信了。
 */

import { z } from 'zod';
import { defineCommand, uuid, cents, basisPoints } from '../command.js';

export const planKind = z.enum([
  'commission',            // 纯提成
  'hourly',                // 纯时薪
  'commission_vs_hourly',  // 保底：两者取大（美国 W-2 最常见）
  'booth_rent',            // 租椅 1099（决策 2，Phase 2 才开 UI）
]);

export const SavePlan = defineCommand({
  name: 'payroll.savePlan',
  input: z.object({
    /** null = 门店默认方案，新人自动套用 */
    membershipId: uuid.nullable(),
    kind: planKind,
    /** 服务提成率。4500 = 45% */
    rateBp: basisPoints,
    /** 分类覆盖：{ [serviceCategoryId]: bp }。蜡疗/贴片这类高毛利项目常单独定 */
    categoryRateBp: z.record(uuid, basisPoints).default({}),
    retailRateBp: basisPoints.default(1000),
    /** 分/小时。kind 含 hourly 时必填 */
    hourlyRateCents: cents.nonnegative().default(0),
    /**
     * 提成基数：折后还是原价。
     * 折扣算谁的，是真店里的头号争议 —— 不给默认值糊弄过去，必须显式选。
     */
    base: z.enum(['net', 'gross']).default('net'),
  }).refine(
    (p) => p.kind === 'commission' || p.kind === 'booth_rent' || p.hourlyRateCents > 0,
    { message: '时薪或保底方案必须填时薪' },
  ),
  output: z.object({ planId: uuid, version: z.number().int() }),
  permission: 'payroll.configure',
  ai: {
    description: '设置某位技师（或门店默认）的薪酬方案。改动只影响之后的单据。',
    confirm: 'always',
  },
  reversible: true,
  idempotency: 'optional',
  // 提成率不是「金额」，可以进审计 —— 谁把提成从 45% 改成 35% 的，
  // 恰恰是最该留痕的一类操作
});

const businessDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const CreatePayrollBatch = defineCommand({
  name: 'payroll.createBatch',
  input: z.object({ periodStart: businessDate, periodEnd: businessDate }),
  output: z.object({ batchId: uuid, itemCount: z.number().int().nonnegative(), status: z.literal('draft') }),
  permission: 'payroll.configure',
  ai: { description: '从已落库收入流水生成工资批次草稿。', confirm: 'always' },
  reversible: false,
  idempotency: 'required',
});

export const MarkPayrollBatchPaid = defineCommand({
  name: 'payroll.markBatchPaid',
  input: z.object({ batchId: uuid, providerBatchId: z.string().max(200).optional(), note: z.string().min(2).max(500) }),
  output: z.object({ batchId: uuid, status: z.literal('paid') }),
  permission: 'payroll.configure',
  ai: { description: '确认工资批次已支付并留下人工或服务商凭据。', confirm: 'always' },
  reversible: false,
  idempotency: 'required',
});

export const PAYROLL_COMMANDS = [SavePlan, CreatePayrollBatch, MarkPayrollBatchPaid] as const;
