/**
 * 命令注册表 —— 单一事实来源。
 *
 * API 路由、前端 SDK、AI 工具定义三者都从这里派生。
 * 加一个命令 = AI 自动会用（01 §3）。
 */

import type { AnyCommandDef } from './command.js';
import { APPOINTMENT_COMMANDS } from './commands/appointment.js';
import { ROTATION_COMMANDS } from './commands/rotation.js';
import { TICKET_COMMANDS } from './commands/ticket.js';

const ALL: readonly AnyCommandDef[] = [...APPOINTMENT_COMMANDS, ...ROTATION_COMMANDS, ...TICKET_COMMANDS];

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
}> {
  return [...COMMAND_REGISTRY.values()]
    .filter((c) => c.ai.exposed !== false)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((c) => ({
      name: c.name,
      description: c.ai.description,
      confirm: c.ai.confirm,
      permission: c.permission,
    }));
}
