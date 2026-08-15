/**
 * 命令总线（01-ARCHITECTURE §3，宪法第 1 条）
 *
 * 每一个写操作都走这一条管线，UI 和 AI 走的是**同一条**，
 * 不存在「AI 有后门」。
 *
 *   入参校验(Zod) → 权限检查 → 幂等去重
 *     → 事务开始 + SET LOCAL 租户上下文
 *     → 业务规则（容量三层 / 冲突 / 技能）
 *     → 写库 → 写审计(before/after，金额脱敏)
 *     → 提交 → 返回结果（含可撤销窗口）
 *
 * 幂等和审计写在总线里而不是各个 handler 里，是为了让它们**没法被忘记**。
 */

import type { ZodTypeAny, z } from 'zod';
import type postgres from 'postgres';
import { withTenant, jsonb } from '@gf/db';
import {
  AppError, ERROR_CODES,
  type AnyCommandDef, type CommandDef, type CommandContext, type Permission,
} from '@gf/contracts';
import { writeAudit, type AuditEntry } from './audit';

export interface HandlerArgs<TInput> {
  input: TInput;
  ctx: CommandContext;
  tx: postgres.TransactionSql;
  /** handler 通过它登记审计；总线负责真正写入并做金额脱敏 */
  audit: (entry: Omit<AuditEntry, 'command' | 'redactPaths'>) => void;
}

export type Handler<TInput, TOutput> = (args: HandlerArgs<TInput>) => Promise<TOutput>;

interface Registered {
  def: AnyCommandDef;
  handler: Handler<unknown, unknown>;
}

const handlers = new Map<string, Registered>();

export function registerHandler<TIn extends ZodTypeAny, TOut extends ZodTypeAny>(
  def: CommandDef<TIn, TOut>,
  handler: Handler<z.infer<TIn>, z.infer<TOut>>,
): void {
  if (handlers.has(def.name)) throw new Error(`命令 ${def.name} 重复注册`);
  handlers.set(def.name, { def, handler: handler as Handler<unknown, unknown> });
}

export interface DispatchOptions {
  /** 幂等键。def.idempotency === 'required' 时必须给 */
  idempotencyKey?: string;
}

export interface DispatchResult<T> {
  result: T;
  /** 命中幂等缓存 —— 说明这是一次重试，没有真的重复执行 */
  replayed: boolean;
  /** 可撤销的命令返回审计 id，前端据此显示 60 秒「撤销」按钮 */
  undoToken?: string;
}

export async function dispatch<T = unknown>(
  commandName: string,
  rawInput: unknown,
  ctx: CommandContext,
  opts: DispatchOptions = {},
): Promise<DispatchResult<T>> {
  const reg = handlers.get(commandName);
  if (!reg) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { command: commandName } });
  const { def, handler } = reg;

  // ── 1. 入参校验 ───────────────────────────────────────────────────────────
  const parsed = def.input.safeParse(rawInput);
  if (!parsed.success) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: { issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })) },
    });
  }

  // ── 2. 权限 ──────────────────────────────────────────────────────────────
  // AI 的权限是操作人权限的子集：ctx.permissions 在建会话时就已收窄，
  // 这里不区分 actorKind —— 分不清才是对的，AI 不该有特殊路径。
  if (!ctx.permissions.has(def.permission as Permission)) {
    throw new AppError(ERROR_CODES.PERMISSION_DENIED, {
      details: { command: commandName, need: def.permission },
    });
  }

  // ── 3. 幂等 ──────────────────────────────────────────────────────────────
  const key = opts.idempotencyKey;
  if (def.idempotency === 'required' && !key) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: { reason: `${commandName} 需要 idempotencyKey` },
      messageKey: 'error.IDEMPOTENCY_KEY_REQUIRED',
    });
  }

  return withTenant(
    { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: ctx.membershipId },
    async (tx) => {
      if (key) {
        const hit = await tx<{ result_json: unknown; command: string }[]>`
          select result_json, command from command_idempotency
          where location_id = ${ctx.locationId} and key = ${key}`;
        if (hit.length > 0) {
          // 同一个幂等键用在不同命令上，多半是客户端 bug，不能静默返回上一个结果
          if (hit[0]!.command !== commandName) {
            throw new AppError(ERROR_CODES.IDEMPOTENCY_KEY_REUSED, {
              details: { key, usedBy: hit[0]!.command, attempted: commandName },
            });
          }
          return { result: hit[0]!.result_json as T, replayed: true };
        }
      }

      // ── 4. 执行 ────────────────────────────────────────────────────────────
      const entries: Array<Omit<AuditEntry, 'command' | 'redactPaths'>> = [];
      const result = await handler({
        input: parsed.data,
        ctx,
        tx,
        audit: (e) => entries.push(e),
      });

      // ── 5. 审计 ────────────────────────────────────────────────────────────
      // 一个命令没登记任何审计条目 = 写操作没留痕，直接当 bug 拦下。
      if (entries.length === 0) {
        throw new Error(`命令 ${commandName} 没有登记审计条目（宪法第 1 条）`);
      }
      let undoToken: string | undefined;
      for (const e of entries) {
        const id = await writeAudit(tx, ctx, {
          ...e, command: commandName, redactPaths: def.auditRedact ?? [],
        });
        undoToken ??= id;
      }

      // ── 6. 记幂等 ──────────────────────────────────────────────────────────
      if (key) {
        await tx`
          insert into command_idempotency (location_id, key, command, result_json)
          values (${ctx.locationId}, ${key}, ${commandName}, ${jsonb(result)}::jsonb)`;
      }

      return {
        result: result as T,
        replayed: false,
        ...(def.reversible && undoToken ? { undoToken } : {}),
      };
    },
  );
}

/** 供 AI 工具生成与路由注册使用 */
export const registeredCommands = (): AnyCommandDef[] => [...handlers.values()].map((h) => h.def);
