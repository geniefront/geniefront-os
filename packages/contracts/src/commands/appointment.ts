/**
 * 预约相关命令。
 *
 * Phase 0 验收要跑通的就是 appointment.create：
 * 产生审计记录、RLS 阻止跨 org 读取、多店切换正常。
 */

import { z } from 'zod';
import { defineCommand, uuid, cents, overrideReason } from '../command.js';

/** 预约来源。AI 产生的数据必须带 source 标记（宪法第 6 条），可筛可撤可审计。 */
export const appointmentSource = z.enum([
  'desk',         // 前台手工建
  'walkin',       // walk-in 队列转入
  'web',          // 公开预约页
  'phone_ai',     // AI 电话（进前台复核队列）
  'phone_manual', // 前台接电话录入
  'repeat',       // 从上次预约复制
]);

export const cancelReason = z.enum([
  'duplicate_booking',
  'walk_out',
  'guest_changed_mind',
  'input_error',
  'no_show',
  'other',
]);

/**
 * 一条 item = 一个项目 + 一个技师 + 一份资源。
 * 冲突检测在 item 级，不在 appointment 级 —— 一家四口做美甲是 4 条 item。
 */
const appointmentItemInput = z.object({
  serviceId: uuid,
  addonIds: z.array(uuid).default([]),
  /** null = 未指定技师，由前台后续派单或轮牌决定 */
  membershipId: uuid.nullable().default(null),
  /** 点钟单。多数店规定指名单不消耗轮次（可配） */
  isRequest: z.boolean().default(false),
  resourceId: uuid.nullable().default(null),
  startsAt: z.string().datetime({ offset: true }),
  /** 不传则取 service.duration_min（按技师等级可能不同） */
  durationMin: z.number().int().positive().max(600).optional(),
  /** 落单要素：力度/部位/甲型/色号…（02 §3.1）。结构由 service_option_defs 定义 */
  details: z.record(z.string(), z.unknown()).default({}),
  priceCentsOverride: cents.optional(),
});

export const AppointmentCreate = defineCommand({
  name: 'appointment.create',
  input: z.object({
    customerId: uuid.nullable(),
    /** 匿名 walk-in：不给 customerId，只留个名字，事后可合并 */
    walkInName: z.string().max(120).optional(),
    items: z.array(appointmentItemInput).min(1).max(20),
    partySize: z.number().int().positive().max(20).default(1),
    notes: z.string().max(2000).optional(),
    source: appointmentSource.default('desk'),
    /**
     * 软约束放行。不传而撞上软约束 → 返回 STAFF_OVER_CAPACITY /
     * LOCATION_OVER_CAPACITY，前台确认后带 reason 重试。
     * 资源硬冲突（房间被占）无论如何都不放行。
     */
    override: overrideReason.optional(),
  }),
  output: z.object({
    appointmentId: uuid,
    itemIds: z.array(uuid),
    /** 哪些 item 是超卖放行的，前台看板要高亮 */
    overbookedItemIds: z.array(uuid),
    businessDate: z.string(), // 门店本地营业日 YYYY-MM-DD，按 business_day_cutoff 算
  }),
  permission: 'appointment.write',
  ai: {
    description:
      '新建一个预约。必须先用只读工具查到真实空档再调用——不许自己推算时间。' +
      '撞上软容量上限时会报错，需要前台确认后带 override 重试。',
    confirm: 'always',
  },
  reversible: true,
  idempotency: 'required',
});

export const AppointmentReschedule = defineCommand({
  name: 'appointment.reschedule',
  input: z.object({
    appointmentId: uuid,
    itemId: uuid.optional(), // 不传 = 整单平移
    startsAt: z.string().datetime({ offset: true }),
    membershipId: uuid.nullable().optional(),
    resourceId: uuid.nullable().optional(),
    override: overrideReason.optional(),
  }),
  output: z.object({
    appointmentId: uuid,
    overbooked: z.boolean(),
  }),
  permission: 'appointment.write',
  ai: {
    description: '把一个已有预约改到新时间，可同时换技师或换房间。',
    confirm: 'always',
  },
  reversible: true,
  idempotency: 'optional',
});

export const AppointmentCancel = defineCommand({
  name: 'appointment.cancel',
  input: z.object({
    appointmentId: uuid,
    reason: cancelReason,
    note: z.string().max(500).optional(),
    /**
     * ⚠️ 04 §7 的轮牌隔离防错补丁：
     * 取消时若技师已被占用，必须问「是否为该技师保留本次轮牌与档期」。
     * 不问的话系统会默认技师没干活，释放档期并打乱轮牌队列 —— 门店排班会大乱。
     * 所以这个字段是必填，没有默认值，强迫调用方做出选择。
     */
    keepStaffTurn: z.boolean(),
  }),
  output: z.object({
    appointmentId: uuid,
    turnKept: z.boolean(),
  }),
  permission: 'appointment.cancel',
  ai: {
    description:
      '取消预约。必须提供标准取消原因；若技师已开始服务，还要明确是否保留他的轮牌与档期。',
    confirm: 'always',
  },
  reversible: true,
  idempotency: 'optional',
});

export const APPOINTMENT_COMMANDS = [
  AppointmentCreate,
  AppointmentReschedule,
  AppointmentCancel,
] as const;
