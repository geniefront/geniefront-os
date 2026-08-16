/**
 * 排班：周模板与班次（Phase 1b）
 *
 * ⚠️ 时间用**营业日 + 墙上分钟**表达，不用 timestamptz。
 * 理由见 packages/scheduling/src/roster.ts 文件头：班表是计划的墙上时间，
 * 烤成时刻会在 DST 那两天让全店班次集体偏移一小时。
 *
 * 跨夜班（足疗店 18:00–次日 02:00）用 endMin > 1440 表达，
 * 不用「结束比开始小」—— 后者分不清是跨夜还是录错了。
 */

import { z } from 'zod';
import { defineCommand, uuid } from '../command.js';

const businessDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const startMin = z.number().int().min(0).max(1439);
const endMin = z.number().int().min(1).max(2640);   // 最晚到次日 20:00
const breakMin = z.number().int().min(0).max(480);

export const SaveShiftTemplate = defineCommand({
  name: 'shift.saveTemplate',
  input: z.object({
    /** 一次提交一个人的整周模板，空数组 = 这人这周不排 */
    membershipId: uuid,
    entries: z.array(z.object({
      weekday: z.number().int().min(0).max(6),   // 0 = 周日
      startMin,
      endMin,
      breakMin: breakMin.default(0),
    })).max(7),
  }),
  output: z.object({ membershipId: uuid, entryCount: z.number().int() }),
  permission: 'schedule.write',
  ai: {
    description: '设置某位技师的每周固定班表模板。时间用当天 0 点起的分钟数。',
    confirm: 'always',
  },
  reversible: true,
  idempotency: 'optional',
});

/**
 * ⭐ 一键铺开。
 *
 * skipExisting 默认 true：**绝不冲掉前台手工调过的班**。
 * 一键铺开最怕的就是把昨天刚协调好的换班覆盖掉 —— 那种事发生一次，
 * 前台就再也不敢点这个按钮了。
 */
export const ApplyShiftTemplate = defineCommand({
  name: 'shift.applyTemplate',
  input: z.object({
    fromDate: businessDate,
    days: z.number().int().min(1).max(62).default(7),
    /** 已有班次的日期是否跳过。false = 覆盖（要前台明确确认） */
    skipExisting: z.boolean().default(true),
    /** 只铺这几个人；不传就是全店 */
    membershipIds: z.array(uuid).max(100).optional(),
  }),
  output: z.object({
    created: z.number().int(),
    skipped: z.number().int(),
    fromDate: z.string(),
    toDate: z.string(),
  }),
  permission: 'schedule.write',
  ai: {
    description: '按周模板铺开未来几天的班表。默认跳过已经排过的日期，不覆盖人工调整。',
    confirm: 'always',
  },
  reversible: true,
  idempotency: 'required',
});

/** 单日调整：改时间、标请假、删掉 */
export const SetShift = defineCommand({
  name: 'shift.set',
  input: z.object({
    membershipId: uuid,
    businessDate,
    /** 'delete' = 这天不排（连行都不留） */
    action: z.enum(['work', 'off', 'delete']).default('work'),
    startMin: startMin.optional(),
    endMin: endMin.optional(),
    breakMin: breakMin.optional(),
    offReason: z.enum(['sick', 'vacation', 'personal', 'store_closed', 'other']).optional(),
    note: z.string().max(200).optional(),
  }),
  output: z.object({ membershipId: uuid, businessDate: z.string(), status: z.string() }),
  permission: 'schedule.write',
  ai: {
    description: '改某人某天的班：上班时间、请假、或取消排班。',
    confirm: 'always',
  },
  reversible: true,
  idempotency: 'optional',
});

/**
 * 发布班表。发布前是草稿（只有前台看得到），发布后技师可见。
 * 这一步存在的意义：老板排到一半改主意是常态，
 * 让技师看到半成品班表比看不到更糟。
 */
export const PublishShifts = defineCommand({
  name: 'shift.publish',
  input: z.object({
    fromDate: businessDate,
    toDate: businessDate,
  }),
  output: z.object({ published: z.number().int() }),
  permission: 'schedule.write',
  ai: { description: '发布一段日期的班表，技师端就能看到了。', confirm: 'always' },
  reversible: true,
  idempotency: 'optional',
});

export const SHIFT_COMMANDS = [
  SaveShiftTemplate, ApplyShiftTemplate, SetShift, PublishShifts,
] as const;
