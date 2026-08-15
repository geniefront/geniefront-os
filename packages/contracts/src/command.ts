/**
 * 命令总线的契约层（01-ARCHITECTURE §3）
 *
 * 宪法第 1 条：所有写操作必须是命令 —— 有名字、Zod schema、权限、幂等键、审计。
 * 页面里不许直接 POST 裸接口。
 *
 * 这里只定义「命令长什么样」，不含执行逻辑（那在 apps/api）。
 * 前端 SDK、API 路由、AI 工具定义三者都从这一份派生 —— 加一个命令，AI 自动会用。
 */

import { z } from 'zod';
import type { Permission } from './permissions.js';

/** AI 调用这个命令时是否需要人工确认 */
export type ConfirmPolicy =
  | 'never'        // 只读或无副作用
  | 'destructive'  // 仅在删除/作废类操作时确认
  | 'always';      // 任何情况下都要前台点确认

export interface CommandAiMeta {
  /** 给模型看的描述。写清楚「什么时候用」，不是「这个函数做什么」 */
  description: string;
  confirm: ConfirmPolicy;
  /** 设为 false 则不暴露给 AI（例如平台内部命令） */
  exposed?: boolean;
}

export interface CommandDef<TInput extends z.ZodTypeAny, TOutput extends z.ZodTypeAny> {
  /** 点分命名：`<聚合>.<动作>`，例如 appointment.reschedule */
  name: string;
  input: TInput;
  output: TOutput;
  permission: Permission;
  ai: CommandAiMeta;
  /** 可撤销 —— 执行后前台会看到 60 秒的「撤销」按钮 */
  reversible: boolean;
  /**
   * 幂等：网络差的门店必须能安全重试。
   * 'required' = 调用方必须带 idempotencyKey；'optional' = 带了就去重。
   */
  idempotency: 'required' | 'optional';
  /**
   * 审计时对 before/after 做字段级脱敏。
   * 宪法第 17 条：ticket / payment 的金额字段不进 audit_log。
   */
  auditRedact?: readonly string[];
}

export function defineCommand<TInput extends z.ZodTypeAny, TOutput extends z.ZodTypeAny>(
  def: CommandDef<TInput, TOutput>,
): CommandDef<TInput, TOutput> {
  if (!/^[a-z][a-z_]*\.[a-z][a-zA-Z]*$/.test(def.name)) {
    throw new Error(`命令名必须是 <聚合>.<动作> 形式，收到：${def.name}`);
  }
  return def;
}

export type AnyCommandDef = CommandDef<z.ZodTypeAny, z.ZodTypeAny>;
export type CommandInput<C> = C extends CommandDef<infer I, z.ZodTypeAny> ? z.infer<I> : never;
export type CommandOutput<C> = C extends CommandDef<z.ZodTypeAny, infer O> ? z.infer<O> : never;

// ─────────────────────────────────────────────────────────────────────────────
// 共用基础类型
// ─────────────────────────────────────────────────────────────────────────────

export const uuid = z.string().uuid();

/** 金额一律整数分（宪法第 4 条）。绝不用浮点表示钱。 */
export const cents = z.number().int();

/** 百分比一律 basis point：10000 = 100%，避免 0.4 变成 0.4000000000000001 */
export const basisPoints = z.number().int().min(0).max(10000);

/** E.164 手机号 */
export const phoneE164 = z.string().regex(/^\+[1-9]\d{7,14}$/, 'must be E.164, e.g. +15125550142');

/** 多语言文本。缺失时回退到门店默认语言。 */
export const LOCALES = ['en', 'zh-Hans', 'zh-Hant', 'ko', 'vi', 'es'] as const;
export type Locale = (typeof LOCALES)[number];
export const localeSchema = z.enum(LOCALES);
export const i18nText = z.record(localeSchema, z.string()).refine(
  (v) => Object.keys(v).length > 0,
  '至少要有一种语言',
);

/**
 * 软约束的放行理由。
 * 决策 17：超卖默认允许，但前台放行必须留下操作人与原因（决策 12 的可解释审计流水）。
 */
export const overrideReason = z.object({
  reason: z.enum([
    'guest_requested',   // 客人指定
    'staff_on_break',    // 技师暂休
    'desk_coordination', // 前台协调
    'walk_in_stacking',  // 堆叠等位（泡脚等）
    'other',
  ]),
  note: z.string().max(500).optional(),
});
export type OverrideReason = z.infer<typeof overrideReason>;

/** 每个命令都在租户上下文里执行。由服务端从会话解析，不接受客户端传入。 */
export interface CommandContext {
  orgId: string;
  locationId: string;
  userId: string;
  membershipId: string;
  permissions: ReadonlySet<Permission>;
  /** 'user' = 人在操作；'ai' = 副驾代操作（权限已收窄为操作人的子集） */
  actorKind: 'user' | 'ai' | 'system' | 'api';
  locale: Locale;
  /** 门店时区，用于营业日边界计算 */
  timezone: string;
  ip?: string;
}
