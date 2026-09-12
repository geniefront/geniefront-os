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
import { emit, type DomainEvent } from './events';

export interface HandlerArgs<TInput> {
  input: TInput;
  ctx: CommandContext;
  tx: postgres.TransactionSql;
  /** handler 通过它登记审计；总线负责真正写入并做金额脱敏 */
  audit: (entry: Omit<AuditEntry, 'command' | 'redactPaths'>) => void;
  /**
   * 登记一条要广播的领域事件（01 §6）。
   *
   * 和审计一样写在总线里而不是各 handler 里，是为了让它**发在同一个事务内** ——
   * 回滚就自动撤销，不会出现「技师手机响了但那张单不存在」。
   */
  emit: (event: DomainEvent) => void;
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
  /**
   * ⭐ 系统自有命令的**调用来源声明**（AUD-01 第二道）。
   *
   * `def.system === true` 的命令必须带这个字段，否则直接拒。写的是
   * 「我核验过什么外部凭据才来记这一笔」—— 例如 `stripe_webhook`、
   * `stripe_payment_intent`、`anthropic_usage`。
   *
   * 为什么要有第二道：第一道（server.ts 的路由拦截）挡的是**今天已知的
   * 那一个入口**。而「按名字执行任意命令」这种泛化入口出现过一次，
   * 就可能再出现第二次（AI 工具、批量接口、内部代理）。那时候第一道不会
   * 自动跟着长出来，而这一道会：新写的调用点不显式声明来源就跑不通，
   * **失败方向是拒绝而不是放行**。
   *
   * 它不是权限、也不是密钥 —— 只有服务端代码写得出来，浏览器无从传入。
   */
  systemOrigin?: string;
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

  // ── 0. 系统自有命令：必须显式声明调用来源（AUD-01）─────────────────────
  //
  // ⚠️ **排在入参校验之前**，这一步的顺序是有讲究的：
  // 放在校验之后的话，「拒不拒」会取决于攻击者有没有把 body 拼对 ——
  // 一个 body 拼错的调用会先拿到 VALIDATION_FAILED，
  // 于是「这条命令我到底能不能调」变成了一个可以被试探出来的问题。
  // 也排在权限检查之前：这不是「权限不够」，是「这条路根本不对外」。
  if (def.system === true && !opts.systemOrigin) {
    throw new AppError(ERROR_CODES.PERMISSION_DENIED, {
      details: { command: commandName, reason: 'system_only_command' },
    });
  }

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
  if (def.permission && !ctx.permissions.has(def.permission as Permission)) {
    throw new AppError(ERROR_CODES.PERMISSION_DENIED, {
      details: { command: commandName, need: def.permission },
    });
  }

  // ── 2b. 字段级权限（AUD-02）───────────────────────────────────────────────
  // 有些能力不是独立命令，而是别的命令入参里的一个字段：打折是
  // `ticket.close.discountCents`，突破容量是 `appointment.create.override`。
  // 这类字段此前只被界面藏起来，而藏起来不是约束 —— 持有 ticket.write 的
  // 技师可以直接把整单折成 0。判定必须排在入参校验之后：要先拿到值，
  // 才能区分「传了 discountCents: 0」和「真的打了折」。
  for (const rule of def.fieldPermissions ?? []) {
    if (rule.used(parsed.data) && !ctx.permissions.has(rule.need)) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, {
        details: { command: commandName, need: rule.need, field: rule.field },
      });
    }
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
    {
      orgId: ctx.orgId,
      locationId: ctx.locationId,
      membershipId: ctx.membershipId,
      userId: ctx.userId,
    },
    async (tx) => {
      // ── 3.5 订阅闸门 ────────────────────────────────────────────────────
      await assertSubscriptionAllowsWrite(tx, ctx, commandName);

      if (key) {
        // 同一门店同一幂等键先串行化。否则两个并发重试都可能先读到“未执行”，
        // 然后各自写业务数据，最后才在幂等表唯一键处撞车。
        await tx`select pg_advisory_xact_lock(
          hashtext(${ctx.locationId}), hashtext(${key}))`;
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
      const events: DomainEvent[] = [];
      const result = await handler({
        input: parsed.data,
        ctx,
        tx,
        audit: (e) => entries.push(e),
        emit: (e) => events.push(e),
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

      // ── 5b. 广播领域事件（仍在事务内，见 events.ts）────────────────────────
      for (const e of events) await emit(tx, ctx.locationId, e);

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

// ─────────────────────────────────────────────────────────────── 订阅闸门

/**
 * 欠费之后仍然放行的命令前缀。
 *
 * ⭐ **必须包含 `billing.`** —— 否则老板换了卡也救不回来，
 * 那是个把自己锁在门外的死结。`setup.` 同理：认领门店这一步
 * 发生在订阅刚建出来、webhook 还没回来的那几秒。
 */
const WRITE_ALLOWED_WHILE_PAST_DUE = ['billing.', 'setup.', 'support.'] as const;

/**
 * 订阅欠费 → **冻结写入，读操作照常**（批 1，docs/03 Phase 2.9）。
 *
 * 三条设计约束：
 *
 * 1. **只冻结写。** 老板照样能看看板、查日结、导出报表 ——
 *    经营数据是他的，欠费不是没收数据的理由。查询路由不经过总线，
 *    所以「读照常」是免费得到的，不需要额外开口子。
 * 2. **判据是 status，不是日期。** 试用期内 status 是 `trialing`，放行；
 *    Stripe 扣款失败后会把它带成 `past_due`，那时才冻。我们不自己数日子 ——
 *    自己数就一定会和 Stripe 的账单周期漂开。
 * 3. **查不到账户行 = 放行。** 种子店、开发库、以及计费上线之前建的老店
 *    都没有这一行。默认冻结的话，`pnpm dev` 起来第一件事就是全线报 402。
 *
 * ⚠️ 放在事务里、在幂等检查**之前** —— 顺序反了的话，欠费期间的重试
 * 会命中幂等缓存并返回一个「成功」，而那次写入其实从来没发生过。
 */
async function assertSubscriptionAllowsWrite(
  tx: postgres.TransactionSql,
  ctx: CommandContext,
  commandName: string,
): Promise<void> {
  if (WRITE_ALLOWED_WHILE_PAST_DUE.some((p) => commandName.startsWith(p))) return;

  const [acct] = await tx<{ status: string }[]>`
    select subscription_status as status
    from billing_accounts where location_id = ${ctx.locationId}`;

  // 没有账户行 = 还没接计费。放行（见上面第 3 条）
  if (!acct) return;
  if (!FROZEN_STATUSES.has(acct.status)) return;

  throw new AppError(ERROR_CODES.SUBSCRIPTION_PAST_DUE, {
    details: { command: commandName, subscriptionStatus: acct.status },
  });
}

/**
 * 哪些状态算欠费。
 *
 * `trialing` 和 `active` 放行。`canceled` 也冻 —— 主动退订之后
 * 数据保留、只读可用，这和欠费是同一种处理。
 *
 * `none`（从未接过计费）**放行**：种子店、开发库、以及自助加店时组织
 * 还没有生效订阅的那种店都属于这一档。它们的约束是「套餐内 AI 额度为 0」
 * （handlers/billing.ts 的 `includedTotalOf`），不是把前台挡在门外。
 *
 * `expired` = **订阅码到期**（迁移 0120）。冻结行为和欠费完全一样，
 * 分开只是为了让界面和运营台能说对话 —— 对一个微信转账的店家说
 * 「你的卡扣不上」是错的信息。
 *
 * ⚠️ 只列**本地真的会出现**的值。`mapSubscriptionStatus` 已经把 Stripe 的
 * `unpaid` / `incomplete_expired` 收敛成 past_due / canceled，
 * 把它们留在集合里会让人误以为那是活的判据。
 */
const FROZEN_STATUSES = new Set(['past_due', 'canceled', 'expired']);
