/**
 * 路由层共用的工具函数。
 *
 * 这些函数原来定义在 server.ts 末尾，每个路由文件都需要它们，
 * 提到这里避免循环引用和重复定义。
 */

import type { CommandContext } from '@gf/contracts';

/** 路由注册函数的标准签名 */
export type CtxFromHeaders = (req: {
  user?: { userId: string };
  headers: Record<string, unknown>;
  ip: string;
}) => Promise<CommandContext>;

/** 今天（UTC 日期）。跨店汇总的默认区间用它兜底，各店的营业日在查询里各算各的 */
export function todayIso(): string { return new Date().toISOString().slice(0, 10); }

/** `YYYY-MM-DD` ± n 天。纯日期算术，不碰时区 */
export function addDaysIso(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
