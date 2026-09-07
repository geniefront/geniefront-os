/**
 * 员工端命令（Phase 1c）：开始 / 完成 / 打卡 / 界面语言
 *
 * ⚠️ 宪法第 14 条：这些命令**不是技师端专属**。
 * Desk-Only 的店，前台代点开始/完成、代打卡，走的是同一条命令 ——
 * 只是多带一个 `membershipId`（替谁做）。
 * 做成两套接口的话，两边的业务规则迟早会漂开。
 */

import { z } from 'zod';
import { defineCommand, uuid, phoneE164, cents, overrideReason } from '../command.js';

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
    /**
     * ⭐ 技师并发的真正闸门在这里，不在开单。
     *
     * 开单只是「记下要做什么」，同时服务几位客人是从**点开始**那一刻
     * 才成立的。撞上上限返回 `STAFF_OVER_CAPACITY`，前台确认后带 reason
     * 重试（门店把 capacity.overbook 设成 block 时不给这个出口）。
     */
    override: overrideReason.optional(),
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

/**
 * ⭐ 把某一项服务换个技师做。
 *
 * 门店里这件事天天发生：技师临时被叫走、客人做到一半要求换人、前台派错了人。
 * 此前系统里没有这条命令 —— 前台唯一的办法是作废整张单重开，
 * 而那会丢掉已经走过的开始时间，多项目单还要连带把别人的项目一起重来。
 *
 * 只改归属，不动时间：开始时间是这一项真实的工时起点，换人不该让它归零。
 * 提成按 `ticket_item_staff` 在结账时结算，因此换人必须发生在完工之前 ——
 * 已完工的项目再改人，等于事后改动别人已经做完的工作的归属。
 */
export const TicketMoveItemStaff = defineCommand({
  name: 'ticket.moveItemStaff',
  input: z.object({
    ticketItemId: uuid,
    /** 接手的技师。 */
    membershipId: uuid,
    /** 双技师协作时指定换掉谁；不传则换掉主技师。 */
    replacesMembershipId: uuid.optional(),
    /** 换人必须留下理由：这条记录是日后核对提成争议的唯一依据。 */
    reason: z.string().trim().min(2).max(500),
  }),
  output: z.object({
    ticketItemId: uuid,
    membershipId: uuid,
    replacedMembershipId: uuid,
  }),
  permission: 'queue.manage',
  ai: {
    description: '把某一项服务改派给另一位技师（技师临时被换走、客人要求换人）。',
    confirm: 'always',
  },
  reversible: false,
  idempotency: 'required',
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

export const TicketSaveServiceNote = defineCommand({
  name: 'ticket.saveServiceNote',
  input: z.object({
    ticketItemId: uuid,
    content: z.string().trim().min(1).max(2000),
    visibility: z.enum(['management', 'assigned_staff']).default('management'),
    containsSensitiveData: z.boolean().default(false),
  }),
  output: z.object({ noteId: uuid, ticketItemId: uuid, updated: z.boolean() }),
  permission: 'ticket.write',
  ai: { description: '保存本次服务的技师备注。', confirm: 'always' },
  reversible: true,
  idempotency: 'optional',
});

/**
 * 记录客人直接交给技师本人的现金小费。
 *
 * 这不是钱箱收款，也不是前台代发：金额计入技师收入，但不会进入现金抽屉
 * 或待发现金小费。修改采用“冲销旧记录 + 新增记录”，保留完整审计链。
 */
export const StaffRecordDirectCashTip = defineCommand({
  name: 'staff.recordDirectCashTip',
  input: z.object({
    ticketItemId: uuid,
    amountCents: cents.nonnegative().max(100_000_00),
    note: z.string().trim().max(200).optional(),
  }),
  output: z.object({
    ticketItemId: uuid,
    amountCents: cents.nonnegative(),
    settlementStatus: z.enum(['no_tip', 'received_direct']),
  }),
  permission: 'ticket.write',
  ai: { description: '记录或更正客人直接交给本人、未进入前台钱箱的现金小费。', confirm: 'always' },
  reversible: true,
  idempotency: 'required',
  auditRedact: ['amountCents'],
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
  ai: { description: '设置我自己的界面语言。', confirm: 'always' },
  reversible: true,
  idempotency: 'optional',
});

// ─────────────────────────────────────────────────────────────────────────────
// 员工花名册：加人 / 离职 / 上机（sql/0031）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ⭐ 加一个员工。
 *
 * 建出来的是一条**没有账号的身份**（Ghost Profile，`user_id is null`）：
 * 老板一加进来他就能被派单、能开单、能算提成 —— **上机是后来的事**。
 *
 * 这个顺序是有意的：一家店最需要「把人加进来」的那一刻，是开店第一天，
 * 而那天技师本人多半不在场，也未必有邮箱。要求「先注册账号才能排班」
 * 等于把开店卡在一件和开店无关的事上。
 *
 * ⚠️ **加不出老板**：`roleKeys` 里不接受 `owner`。
 * 「谁是老板」只由付款那条链路决定（`setup.claimLocation`）——
 * 一个能加员工的店长顺手加出第二个老板，是这条命令最坏的用法。
 */
export const AddStaff = defineCommand({
  name: 'staff.add',
  input: z.object({
    displayName: z.string().min(1).max(40),
    /** 手机号：**店内唯一**。手机验证码上机靠它找人；不填也能加人 */
    phoneE164: phoneE164.optional(),
    /** 角色。不给就是纯技师 */
    roleKeys: z.array(z.enum(['manager', 'front_desk', 'senior_tech', 'tech'])).default(['tech']),
    /** 能不能被排单。老板自己加自己时常常是 false */
    isBookable: z.boolean().default(true),
    maxConcurrentAppointments: z.number().int().min(1).max(5).default(1),
    levelId: uuid.optional(),
    /** 今天要不要吃 walk-in 轮牌 */
    inRotation: z.boolean().default(true),
  }),
  output: z.object({ membershipId: uuid, displayName: z.string() }),
  permission: 'staff.manage',
  ai: {
    description: '新增一位员工（技师/前台/店长）。加进来就能被派单，本人上机是后面的事。',
    confirm: 'always',
  },
  reversible: true,
  idempotency: 'optional',
});

/**
 * 在岗 / 休假 / 离职。
 *
 * ⚠️ **不是删除**：他做过的单、算过的提成、签过的字都还在，
 * 删掉的话那些记录会变成没有主人的孤儿（宪法第 9 条的同一条精神）。
 * 离职之后他从轮牌板、排班、可派单列表里消失，历史一行不动。
 */
export const SetEmployment = defineCommand({
  name: 'staff.setEmployment',
  input: z.object({
    membershipId: uuid,
    status: z.enum(['active', 'on_leave', 'resigned', 'suspended', 'left']),
  }),
  output: z.object({ membershipId: uuid, status: z.string() }),
  permission: 'staff.manage',
  ai: {
    description: '把某位员工设为在职 active / 休假 on_leave (suspended) / 离职 resigned (left)。离职不删除任何历史记录并自动注销登录会话。',
    confirm: 'always',
  },
  reversible: true,
  idempotency: 'optional',
});

export { SaveStaffProfile as StaffSaveProfile } from './setup.js';

/**
 * ⭐ 生成上机码 —— 技师在自己手机上登录的**第一条路**。
 *
 * 老板点一下，屏幕上出现 6 位数字，念给技师，他在手机上输一次就绑定了。
 *
 * 为什么这条路排在手机验证码前面：**它不依赖短信**。
 * 宪法第 13 条（短信不进依赖链）与 `09` §1.2（10DLC 没批之前不写短信依赖）
 * 都还生效 —— 而美国 A2P 没批下来时，验证码大概率被运营商静默过滤，
 * 那时候唯一能用的就是这一条。
 *
 * ⚠️ 码只有 6 位、几分钟有效、**一次性**，而且明文只在返回里出现一次。
 */
export const IssueStaffClaimCode = defineCommand({
  name: 'staff.issueClaimCode',
  input: z.object({ membershipId: uuid }),
  output: z.object({
    membershipId: uuid,
    /** 明文只在这一次返回里存在。库里只有摘要 */
    code: z.string(),
    expiresAt: z.string(),
  }),
  permission: 'staff.manage',
  ai: {
    description: '给某位员工生成一个几分钟有效的上机码，用来在他自己手机上登录。',
    confirm: 'always',
    // ⛔ 不给 AI：这条命令的产出是一把能变成身份的钥匙
    exposed: false,
  },
  reversible: false,
  idempotency: 'optional',
});

/**
 * 踢下线（手机丢了、人离职了）。
 *
 * ⭐ **这就是不自签 JWT 的理由**：会话是一行数据，撤销是一次 update，
 * 立刻生效。自签令牌要么等它过期，要么再造一张吊销名单 —— 而那张名单
 * 本身又是一处会忘记同步的状态。
 */
export const RevokeStaffSessions = defineCommand({
  name: 'staff.revokeSessions',
  input: z.object({ membershipId: uuid }),
  output: z.object({ membershipId: uuid, revoked: z.number().int() }),
  permission: 'staff.manage',
  ai: {
    description: '让某位员工手机上的登录立刻失效（手机丢了/离职）。',
    confirm: 'always',
  },
  reversible: false,
  idempotency: 'optional',
});

export const STAFF_COMMANDS = [
  TicketStartItem, TicketFinishItem, TicketMoveItemStaff, TicketSaveServiceNote, TimeclockPunch, SetMyLocale,
  AddStaff, SetEmployment, IssueStaffClaimCode, RevokeStaffSessions,
] as const;
