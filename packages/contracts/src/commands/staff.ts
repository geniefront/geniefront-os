/**
 * 员工端命令（Phase 1c）：开始 / 完成 / 打卡 / 界面语言
 *
 * ⚠️ 宪法第 14 条：这些命令**不是技师端专属**。
 * Desk-Only 的店，前台代点开始/完成、代打卡，走的是同一条命令 ——
 * 只是多带一个 `membershipId`（替谁做）。
 * 做成两套接口的话，两边的业务规则迟早会漂开。
 */

import { z } from 'zod';
import { defineCommand, uuid } from '../command.js';

/**
 * ⭐ 开始做这一项。
 *
 * 为什么按 ticket_item 而不是整张单：一张单可能有两个项目由两个人做
 * （洗头工先洗、技师再剪），各自的开始/完成时间是各自的工时。
 */
export const TicketStartItem = defineCommand({
  name: 'ticket.startItem',
  input: z.object({
    ticketItemId: uuid,
    /** 前台代点时传：替谁点的。不传就是自己点的 */
    membershipId: uuid.optional(),
  }),
  output: z.object({ ticketItemId: uuid, startedAt: z.string() }),
  permission: 'ticket.write',
  ai: {
    description: '技师开始做某一项服务（或前台代点开始）。',
    confirm: 'always',
  },
  reversible: true,
  idempotency: 'optional',
});

export const TicketFinishItem = defineCommand({
  name: 'ticket.finishItem',
  input: z.object({
    ticketItemId: uuid,
    membershipId: uuid.optional(),
  }),
  output: z.object({
    ticketItemId: uuid,
    finishedAt: z.string(),
    /** 实际做了多少分钟。与预估时长的差异是排期优化的输入 */
    actualMinutes: z.number().int(),
    /** 这张单是不是全做完了 —— 是的话前台该去结账了 */
    ticketDone: z.boolean(),
  }),
  permission: 'ticket.write',
  ai: {
    description: '技师做完某一项服务（或前台代点完成）。做完全部项目后前台可以结账。',
    confirm: 'always',
  },
  reversible: true,
  idempotency: 'optional',
});

/**
 * ⭐ 打卡。
 *
 * 三种来源，法律含义不同，必须分开记：
 *   pin  = 技师在共享 iPad 上输 PIN 自己打的
 *   app  = 技师用自己手机（已登录）打的
 *   desk = **前台代打的** —— 纠纷里第一个被问的就是「谁替谁打的卡」
 */
export const TimeclockPunch = defineCommand({
  name: 'timeclock.punch',
  input: z.object({
    kind: z.enum(['clock_in', 'clock_out', 'break_start', 'break_end']),
    /** 代打卡时传。不传就是给自己打 */
    membershipId: uuid.optional(),
    /** 代技师打卡或共享设备上打卡时，用 PIN 确认身份 */
    pin: z.string().regex(/^\d{4,6}$/).optional(),
    note: z.string().max(200).optional(),
  }),
  output: z.object({
    punchId: uuid,
    kind: z.string(),
    at: z.string(),
    /** 打完这一下之后是在岗还是下班 —— 界面直接照着显示，不用自己推 */
    onDuty: z.boolean(),
    workedMinutes: z.number().int(),
  }),
  permission: 'timeclock.punch_self',
  ai: {
    description: '上下班打卡或休息打卡。给别人打卡需要 timeclock.punch_others 权限。',
    confirm: 'always',
  },
  reversible: true,
  idempotency: 'optional',
});

/**
 * 界面语言**按人**存，不按店（`00` §2 ⭐）。
 *
 * 同一家店里前台说中文、技师说越南语是常态；
 * 而共享 iPad 上换个人就该换语言 —— 存 localStorage 是不够的。
 */
export const SetMyLocale = defineCommand({
  name: 'staff.setLocale',
  input: z.object({
    locale: z.enum(['en', 'zh-Hans', 'zh-Hant', 'ko', 'vi', 'es']),
  }),
  output: z.object({ locale: z.string() }),
  permission: 'appointment.read',   // 人人都有的最低权限：改自己的语言不需要额外授权
  ai: { description: '设置我自己的界面语言。', confirm: 'never' },
  reversible: true,
  idempotency: 'optional',
});

export const STAFF_COMMANDS = [
  TicketStartItem, TicketFinishItem, TimeclockPunch, SetMyLocale,
] as const;
