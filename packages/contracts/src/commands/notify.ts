/**
 * 折扣明细 + 通知模板的命令（批 7）。
 */

import { z } from 'zod';
import { defineCommand } from '../command.js';
import { NOTIFICATION_EVENTS } from '../notification.js';

const uuid = z.string().uuid();
const cents = z.number().int();
const i18nText = z.record(z.string().min(1), z.string().max(200));

export const SaveDiscountReason = defineCommand({
  name: 'discount.saveReason',
  input: z.object({
    id: uuid.optional(),
    label: i18nText,
    /**
     * 超过这个金额要授权。不填 = 不限。
     *
     * ⚠️ 这是个真实的管理问题：不设限的话，一个新前台可以整天给人
     * 打五折；设死了她每次都要去找老板。所以按原因分别设。
     */
    maxSelfApproveCents: cents.nonnegative().nullable().optional(),
    active: z.boolean().default(true),
  }),
  output: z.object({ reasonId: uuid }),
  permission: 'settings.manage',
  ai: { description: '维护折扣原因的预置选项与自助授权额度。', confirm: 'always' },
  reversible: true,
  idempotency: 'optional',
});

export const ApplyDiscount = defineCommand({
  name: 'discount.apply',
  input: z.object({
    ticketId: uuid,
    /** 挂在哪一项上。不填 = 整单 */
    ticketItemId: uuid.nullable().optional(),
    kind: z.enum(['amount', 'percent']),
    /** kind=amount 时是金额，kind=percent 时忽略（用 percentBp） */
    amountCents: cents.nonnegative().optional(),
    percentBp: z.number().int().min(1).max(10000).optional(),
    reasonId: uuid.nullable().optional(),
    reasonText: z.string().max(200).optional(),
    /**
     * 超额授权人。
     *
     * ⚠️ 这里传的是**membership id**，而真实场景是老板过来在前台的
     * 屏幕上点一下 —— 界面要做成「请老板确认」而不是一个下拉框，
     * 否则前台可以自己选老板的名字（那样这道闸就是装饰）。
     */
    approvedBy: uuid.nullable().optional(),
  }),
  output: z.object({
    discountId: uuid,
    amountCents: cents,
    /** 这一单折扣后还剩多少 */
    ticketSubtotalCents: cents,
  }),
  permission: 'ticket.discount',
  ai: { description: '给一张单打折，必须说明原因。', confirm: 'always' },
  reversible: true,
  idempotency: 'required',
});

export const VoidDiscount = defineCommand({
  name: 'discount.void',
  input: z.object({
    discountId: uuid,
    reason: z.string().min(2).max(200),
  }),
  output: z.object({ discountId: uuid, ticketSubtotalCents: cents }),
  permission: 'ticket.discount',
  ai: { description: '撤销一笔已经打上去的折扣。', confirm: 'always' },
  reversible: false,
  idempotency: 'required',
});

export const SaveNotificationTemplate = defineCommand({
  name: 'notification.saveTemplate',
  input: z.object({
    eventKey: z.enum(NOTIFICATION_EVENTS),
    channel: z.enum(['sms', 'email']),
    locale: z.enum(['en', 'zh-Hans', 'zh-Hant', 'ko', 'vi', 'es']).default('en'),
    subject: z.string().max(200).nullable().optional(),
    body: z.string().min(1).max(4000),
    active: z.boolean().default(true),
  }),
  output: z.object({ templateId: uuid, version: z.number().int() }),
  permission: 'settings.manage',
  ai: {
    description: '改一条通知模板。⚠️ 每次保存都是一个新版本，队列里已有的消息仍用旧版本。',
    confirm: 'always',
  },
  reversible: false,
  idempotency: 'optional',
});

export const ToggleNotificationRule = defineCommand({
  name: 'notification.toggleRule',
  input: z.object({
    eventKey: z.enum(NOTIFICATION_EVENTS),
    enabled: z.boolean(),
    /** 走哪些渠道。空数组等同于关掉 */
    channels: z.array(z.enum(['sms', 'email'])).max(2).default([]),
    /** 延迟多少分钟。**负数 = 事件之前**（提醒类用，如 -1440 = 提前一天） */
    offsetMin: z.number().int().min(-10080).max(10080).default(0),
  }),
  output: z.object({ eventKey: z.string(), enabled: z.boolean() }),
  permission: 'settings.manage',
  ai: { description: '打开或关闭一类通知，并设置渠道与提前量。', confirm: 'always' },
  reversible: true,
  idempotency: 'optional',
});

/**
 * 节日营销的日程。
 *
 * ## 为什么只有节日需要人来定
 *
 * 生日、唤回、求评都能从既有数据推出触发时刻；节日不能 ——「感恩节」是哪天、
 * 中文店要不要发中秋，系统无从判断。`{{holiday_name}}` 这个模板变量的存在
 * 本身就说明了这一点：它要一个名字。
 *
 * ⚠️ 同一家店同一天只留一条：两条一起发，顾客一天收两封。
 */
export const SaveMarketingHoliday = defineCommand({
  name: 'marketing.saveHoliday',
  input: z.object({
    /** 不传 = 新增；传了 = 改这一条 */
    holidayId: uuid.optional(),
    /** 填进 {{holiday_name}} 的名字。⚠️ 顾客看得到，所以要英文 */
    name: z.string().trim().min(1).max(60),
    /** 门店本地日期，`YYYY-MM-DD` */
    sendOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD'),
    enabled: z.boolean().default(true),
  }),
  output: z.object({ holidayId: uuid, sendOn: z.string() }),
  permission: 'settings.manage',
  ai: {
    description: '新增或修改一个节日营销日程（哪一天、叫什么）。不影响是否真的发出去 —— 那还要过营销的几道闸门。',
    confirm: 'always',
  },
  reversible: true,
  idempotency: 'optional',
});

export const DeleteMarketingHoliday = defineCommand({
  name: 'marketing.deleteHoliday',
  input: z.object({ holidayId: uuid }),
  output: z.object({ holidayId: uuid }),
  permission: 'settings.manage',
  ai: { description: '删掉一个节日营销日程。', confirm: 'always' },
  reversible: false,
  idempotency: 'optional',
});

export const NOTIFY_COMMANDS = [
  SaveDiscountReason, ApplyDiscount, VoidDiscount,
  SaveNotificationTemplate, ToggleNotificationRule,
  SaveMarketingHoliday, DeleteMarketingHoliday,
] as const;
