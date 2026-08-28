/**
 * 轮牌命令。
 *
 * 决策 12：前台拥有最终裁决权 —— 可以手动调序、强行改派，
 * 但**每一次干预都必须带原因并落成事件**。
 * 这不是官僚流程，是杜绝技师之间"前台偏心"猜忌的唯一办法：
 * 有人质疑时，前台能一条条把流水给他看。
 */

import { z } from 'zod';
import { defineCommand, uuid } from '../command.js';

/** 手动干预的原因。枚举而不是自由文本 —— 便于统计「谁被特殊照顾得最多」 */
export const rotationOverrideReason = z.enum([
  'guest_requested',    // 客人指定
  'staff_on_break',     // 技师暂休
  'desk_coordination',  // 前台协调
  'skill_mismatch',     // 不会做这个项目
  'owed_makeup',        // 补之前欠的轮
  'other',
]);

export const RotationReorder = defineCommand({
  name: 'rotation.reorder',
  input: z.object({
    membershipId: uuid,
    /** 目标位次，0 起 */
    toPosition: z.number().int().min(0).max(50),
    reason: rotationOverrideReason,
    note: z.string().max(300).optional(),
  }),
  output: z.object({ eventId: uuid, membershipId: uuid, toPosition: z.number().int() }),
  permission: 'rotation.override',
  ai: {
    description: '把某位技师在轮牌队列里手动移到指定位次。必须给原因。',
    confirm: 'always',
  },
  reversible: true,
  idempotency: 'optional',
});

export const RotationSkip = defineCommand({
  name: 'rotation.skip',
  input: z.object({
    membershipId: uuid,
    kind: z.enum(['no_skill', 'off']),
    note: z.string().max(300).optional(),
  }),
  output: z.object({ eventId: uuid, owed: z.number().int() }),
  permission: 'rotation.override',
  ai: {
    description: '跳过某位技师。no_skill = 不会做这个项目（默认不算他一轮、下次优先）；off = 请假/下班。',
    confirm: 'always',
  },
  reversible: true,
  idempotency: 'optional',
});

export const RotationSetBreak = defineCommand({
  name: 'rotation.setBreak',
  input: z.object({
    membershipId: uuid,
    onBreak: z.boolean(),
    note: z.string().max(300).optional(),
  }),
  output: z.object({ eventId: uuid, onBreak: z.boolean() }),
  permission: 'rotation.override',
  ai: {
    description: '把技师标记为休息中或休息结束。休息中默认离开轮牌队列。',
    confirm: 'destructive',
  },
  reversible: true,
  idempotency: 'optional',
});

/** 叫号：把下一位（或指定的人）派出去，消耗轮次 */
export const RotationAssign = defineCommand({
  name: 'rotation.assign',
  input: z.object({
    membershipId: uuid,
    /** 点钟单默认不消耗轮次 */
    isRequest: z.boolean().default(false),
    /** 按金额折算轮次；不传则按整轮算 */
    amountCents: z.number().int().nonnegative().optional(),
    customerName: z.string().max(120).optional(),
    note: z.string().max(300).optional(),
  }),
  output: z.object({
    eventId: uuid, membershipId: uuid,
    consumedBp: z.number().int(),
    nextUpMembershipId: uuid.nullable(),
  }),
  permission: 'appointment.write',
  ai: {
    description: '把 walk-in 客人派给某位技师，消耗对应轮次。点钟单要把 isRequest 设为 true。',
    confirm: 'always',
  },
  reversible: true,
  idempotency: 'required',
});

export const QueueRollbackStage = defineCommand({
  name: 'queue.rollbackStage',
  input: z.object({
    appointmentId: uuid,
    queueId: uuid.optional(),
    fromStage: z.enum(['checked_in', 'waiting', 'in_service', 'ready_to_pay', 'completed']),
    targetStage: z.enum(['booked', 'checked_in', 'waiting', 'in_service']),
    reason: z.enum(['wrong_drag', 'customer_delayed', 'service_restart', 'other']),
    notes: z.string().max(1000).optional(),
  }),
  output: z.object({
    appointmentId: uuid,
    targetStage: z.string(),
    rolledBack: z.boolean(),
  }),
  permission: 'appointment.write',
  ai: {
    description: '前台发生误操作或顾客变更时，安全逆向回退看板状态。',
    confirm: 'always',
  },
  reversible: true,
  idempotency: 'optional',
});

export const RotationCheckIn = defineCommand({
  name: 'rotation.checkIn',
  input: z.object({
    membershipId: uuid,
    note: z.string().max(300).optional(),
  }),
  output: z.object({ eventId: uuid, membershipId: uuid, arrivedAt: z.string() }),
  permission: 'rotation.override',
  ai: {
    description: '技师到店打卡上牌，开始参与今日轮牌队列。',
    confirm: 'always',
  },
  reversible: true,
  idempotency: 'optional',
});

export const RotationCheckOut = defineCommand({
  name: 'rotation.checkOut',
  input: z.object({
    membershipId: uuid,
    note: z.string().max(300).optional(),
  }),
  output: z.object({ eventId: uuid, membershipId: uuid, leftAt: z.string() }),
  permission: 'rotation.override',
  ai: {
    description: '技师下班离店离牌，退出今日轮牌队列。',
    confirm: 'always',
  },
  reversible: true,
  idempotency: 'optional',
});

export const RotationUpdatePolicy = defineCommand({
  name: 'rotation.updatePolicy',
  input: z.object({
    enabled: z.boolean().optional(),
    carryOverNextDay: z.boolean().optional(),
    startingMode: z.enum(['clock_in_order', 'designated_staff', 'carry_over', 'balanced']).optional(),
    startingStaffMembershipId: uuid.nullable().optional(),
    requestCountsAsTurn: z.boolean().optional(),
    skipNoSkill: z.enum(['no_penalty', 'counts_as_turn']).optional(),
    owedTurnPriority: z.boolean().optional(),
    onBreak: z.enum(['off_rotation', 'stay_in_place']).optional(),
  }),
  output: z.object({ success: z.boolean(), version: z.number().int() }),
  permission: 'settings.manage',
  ai: {
    description: '店主配置轮牌规则（开关、跨天接续策略、首发技师、点钟规则等）。',
    confirm: 'destructive',
  },
  reversible: true,
  idempotency: 'optional',
});

export const ROTATION_COMMANDS = [
  RotationReorder, RotationSkip, RotationSetBreak, RotationAssign, QueueRollbackStage,
  RotationCheckIn, RotationCheckOut, RotationUpdatePolicy,
] as const;
