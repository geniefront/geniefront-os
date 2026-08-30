/**
 * 命令注册表 —— 单一事实来源。
 *
 * API 路由、前端 SDK、AI 工具定义三者都从这里派生。
 * 加一个命令 = AI 自动会用（01 §3）。
 */

import type { AnyCommandDef } from './command.js';
import { describeInput } from './aiSchema.js';
import { APPOINTMENT_COMMANDS } from './commands/appointment.js';
import { ROTATION_COMMANDS } from './commands/rotation.js';
import { TICKET_COMMANDS } from './commands/ticket.js';
import { SETUP_COMMANDS } from './commands/setup.js';
import { PAYROLL_COMMANDS } from './commands/payroll.js';
import { DAYCLOSE_COMMANDS } from './commands/dayclose.js';
import { SHIFT_COMMANDS } from './commands/shift.js';
import { STAFF_COMMANDS } from './commands/staff.js';
import { BLUEPRINT_COMMANDS } from './commands/blueprint.js';
import { PHONE_COMMANDS } from './commands/phone.js';
import { GIFTCARD_COMMANDS } from './commands/giftcard.js';
import { NOTIFY_COMMANDS } from './commands/notify.js';
import { STOREFRONT_COMMANDS } from './commands/storefront.js';
import { YELP_COMMANDS } from './commands/yelp.js';
import { GOOGLE_COMMANDS } from './commands/google.js';
import { KIOSK_COMMANDS } from './commands/kiosk.js';
import { BILLING_COMMANDS } from './commands/billing.js';
import { AI_COMMANDS } from './commands/ai.js';
import { ANALYTICS_COMMANDS } from './commands/analytics.js';
import { CUSTOMER_COMMANDS } from './commands/customer.js';
import { SMS_COMMANDS } from './commands/sms.js';
import { RESOURCE_COMMANDS } from './commands/resource.js';
import { MARKETING_COMMANDS } from './commands/marketing.js';
import { PROFILE_COMMANDS } from './commands/profile.js';
import { NOTIFICATION_COMMANDS } from './commands/notifications.js';
import { SUPPORT_COMMANDS } from './commands/support.js';

const ALL: readonly AnyCommandDef[] = [
  ...APPOINTMENT_COMMANDS, ...ROTATION_COMMANDS, ...TICKET_COMMANDS, ...SETUP_COMMANDS,
  ...PAYROLL_COMMANDS, ...DAYCLOSE_COMMANDS, ...SHIFT_COMMANDS, ...STAFF_COMMANDS,
  ...BLUEPRINT_COMMANDS, ...PHONE_COMMANDS,
  ...GIFTCARD_COMMANDS, ...NOTIFY_COMMANDS, ...STOREFRONT_COMMANDS, ...YELP_COMMANDS, ...GOOGLE_COMMANDS, ...KIOSK_COMMANDS,
  ...BILLING_COMMANDS, ...AI_COMMANDS, ...ANALYTICS_COMMANDS,
  ...CUSTOMER_COMMANDS, ...SMS_COMMANDS, ...RESOURCE_COMMANDS, ...MARKETING_COMMANDS,
  ...PROFILE_COMMANDS, ...NOTIFICATION_COMMANDS, ...SUPPORT_COMMANDS,
];

export const COMMAND_REGISTRY: ReadonlyMap<string, AnyCommandDef> = new Map(
  ALL.map((c) => [c.name, c]),
);

// 重名会让路由静默覆盖，起步就挡掉
if (COMMAND_REGISTRY.size !== ALL.length) {
  const seen = new Set<string>();
  const dupes = ALL.map((c) => c.name).filter((n) => (seen.has(n) ? true : (seen.add(n), false)));
  throw new Error(`命令名重复：${[...new Set(dupes)].join(', ')}`);
}

export function getCommand(name: string): AnyCommandDef | undefined {
  return COMMAND_REGISTRY.get(name);
}

/**
 * 导出给 AI 的工具定义。
 *
 * 两条缓存纪律（05 §6.2）：
 *  - 按 name 确定性排序 —— 顺序一变，prompt 前缀缓存全部失效
 *  - 不因门店功能开关增删工具，否则每家店的前缀都不同，缓存命中率归零
 */
export function aiToolDefinitions(): Array<{
  name: string;
  description: string;
  confirm: string;
  permission: string;
  /** 入参的一行说明，由 Zod schema 自动压出来（见 aiSchema.ts 顶部的取舍） */
  input: string;
}> {
  return [...COMMAND_REGISTRY.values()]
    .filter((c) => c.ai.exposed !== false)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((c) => ({
      name: c.name,
      description: c.ai.description,
      confirm: c.ai.confirm,
      permission: c.permission ?? '',
      input: describeInput(c.input),
    }));

}

/**
 * 命令目录，渲染成给模型看的文本。**这段进缓存断点之前。**
 *
 * ⚠️ 它必须**逐字节稳定**（05 §6.2）：不许按门店的功能开关增删命令，
 * 也不许把权限过滤放在这里。每家店看到的目录都一样，缓存才有意义。
 *
 * 权限在**执行那一刻**由命令总线检查（bus.ts 第 2 步，AI 的权限
 * 已经收窄成操作人的子集）。模型提议一条它没权限的命令，
 * 结果是一个 PERMISSION_DENIED，不是一次越权写入。
 */
export function commandCatalogText(): string {
  return aiToolDefinitions()
    .map((c) => `${c.name} [${c.confirm}] ${c.input}\n  ${c.description}`)
    .join('\n');
}
