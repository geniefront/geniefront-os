import { AsYouType, parsePhoneNumberFromString } from 'libphonenumber-js/min';
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
import { AppError, ERROR_CODES } from './errors.js';

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
  permission?: Permission;
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
  /**
   * ⭐ **系统自有命令**（AUD-01）。
   *
   * `true` 表示这条命令记录的是一个**已经在外部系统里发生过的事实**
   * （Stripe 扣款成功、订阅状态变化、AI 调用已产生成本），
   * 而不是租户可以自行发起的意图。
   *
   * 判据只有一条：**如果租户能直接调它，他就能凭空写出一个没有发生过的事实。**
   * `billing.syncSubscription` 能把自己写成 growth/active，
   * `billing.recordTopup` 能凭空造出十万积分 —— 两者都不需要 Stripe 参与。
   *
   * 加这个字段之前，「内部命令」这件事只由 `ai.exposed: false` 表达，
   * 而那个字段**只管 AI 工具生成，完全不影响 HTTP 路由** ——
   * 于是每一条内部计费命令都能被任何持有 `billing.manage` 的老板
   * 从 `POST /v1/commands/:name` 直接调用（实测可复现）。
   *
   * 语义边界要说清楚：这**不是**第二套权限，权限照常检查。
   * 它约束的是**入口**：系统自有命令只能由服务端编排代码在
   * 验完外部凭据（Stripe 验签、Stripe 扣款回执、模型调用回执）之后调用，
   * 永远不能由浏览器直接点名调用。执行仍然走同一条总线 ——
   * 审计、幂等、RLS、订阅闸门一条都不少（宪法第 1 条没有被绕开）。
   */
  system?: boolean;

  /**
   * ⭐ **字段级权限**（AUD-02）。
   *
   * `permission` 守的是「能不能调这条命令」。但有些能力并不是一条独立命令，
   * 而是另一条命令入参里的**一个字段** —— 打折是 `ticket.close` 的
   * `discountCents`，突破容量是 `appointment.create` 的 `override`。
   * 这类能力此前完全没有服务端判定：界面把输入框藏起来了，
   * 于是「藏起来」成了唯一的约束，而那不是约束。
   *
   * 判据：**如果这个字段自己就配得上一条权限，那它就必须在这里声明。**
   * 权限清单里有 `ticket.discount`、`appointment.overbook` 两条，
   * 却没有任何命令要求它们 —— 那不是「权限没用上」，是「权限没生效」：
   * 店主在设置页取消勾选，以为限住了打折，实际什么也没发生。
   *
   * 判定在总线里统一进行（`apps/api/src/bus.ts`），排在入参校验之后
   * —— 要先知道字段的值，才知道这项能力有没有真的被使用。
   * 不放在 handler 里的理由：放在 handler 里就等于要求每个加字段的人
   * 记得加判定，而这条 bug 本身就是没人记得的产物。
   */
  fieldPermissions?: readonly FieldPermission[];
}

/** 单条字段级权限声明。 */
export interface FieldPermission {
  /**
   * 该能力是否真的被使用了。只看**值**，不看字段在不在 —— 传了
   * `discountCents: 0` 不是打折，不该因此要求打折权限。
   */
  used: (input: any) => boolean;
  need: Permission;
  /** 被拒时回给调用方的字段名，用于给出「你不能改这一项」而非笼统的权限不足。 */
  field: string;
}

export function defineCommand<TInput extends z.ZodTypeAny, TOutput extends z.ZodTypeAny>(
  def: CommandDef<TInput, TOutput>,
): CommandDef<TInput, TOutput> {
  if (!/^[a-z][a-z0-9_]*\.[a-z][a-zA-Z0-9]*$/.test(def.name)) {
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

/** Normalize complete phones only. National numbers default to +1; other countries require +/00. */
export function normalizePhoneE164(input: string): string | null {
  if (typeof input !== 'string') return null;
  const raw = input.normalize('NFKC').trim();
  if (!raw || !/^[+\d\s().-]+$/.test(raw) || (raw.match(/\+/g)?.length ?? 0) > 1 || (raw.includes('+') && !raw.startsWith('+'))) return null;
  const digits = raw.replace(/\D/g, '');
  const international = raw.startsWith('+') || raw.startsWith('00');
  if (!international && !(digits.length === 10 || (digits.length === 11 && digits.startsWith('1')))) return null;
  const candidate = raw.startsWith('00') ? `+${digits.slice(2)}` : raw;
  const number = parsePhoneNumberFromString(candidate, 'US');
  if (!number || number.ext || !number.isPossible()) return null;
  if (number.countryCallingCode === '1' && !/^[2-9]\d{2}[2-9]\d{6}$/.test(number.nationalNumber)) return null;
  return number.number;
}

/** Preserve incomplete/invalid values for correction; never silently truncate a phone. */
export function formatPhoneInput(input: string | null | undefined): string {
  if (!input) return '';
  const raw = String(input).normalize('NFKC').trim();
  if (!/^[+\d\s().-]+$/.test(raw)) return raw;
  const digits = raw.replace(/\D/g, '');
  if (!digits) return raw;
  const international = raw.startsWith('+') || raw.startsWith('00');
  const normalized = normalizePhoneE164(raw);
  if (normalized) return parsePhoneNumberFromString(normalized)!.formatInternational();
  // Keep overlong or malformed values visible so validation can reject them.
  if (digits.length > (international ? 15 : 11) || (raw.match(/\+/g)?.length ?? 0) > 1) return raw;
  const candidate = raw.startsWith('00') ? `+${digits.slice(2)}`
    : raw.startsWith('+') ? raw : `+1${digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits}`;
  return new AsYouType().input(candidate);
}

export function formatPhoneDisplay(input: string | null | undefined): string {
  if (!input) return '';
  const normalized = normalizePhoneE164(input);
  return normalized ? parsePhoneNumberFromString(normalized)!.formatInternational() : input;
}

/** 输入可带空格/括号/横线；命令 handler 收到的永远是规范 E.164。 */
export const phoneE164 = z.string().transform((raw, ctx) => {
  const normalized = normalizePhoneE164(raw);
  if (!normalized) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'must be a valid phone number, e.g. +15125550142 or (512) 555-0142',
    });
    return z.NEVER;
  }
  return normalized;
});

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
  /**
   * ⚠️ 可以为 null，而且是**两种**情况：
   *
   *   · 系统 actor（Stripe / Telnyx 的 webhook、门口 iPad）—— 背后没有人
   *   · **手机上机的技师** —— 背后有人，但他没有 Supabase 账号：
   *     身份是那条 membership 本身（Ghost Profile，sql/0031）
   *
   * 需要「这个人的账号」的命令（改 users 表、认领门店）用 `actingUser()`
   * 断言非 null。审计不受影响 —— `audit_log.actor_id` 记的一直是
   * **membership**，不是 user。
   */
  userId: string | null;
  /**
   * ⚠️ 可以为 null：**AI 电话背后没有人**。
   *
   * webhook 打进来时没有会话、没有 membership —— 它是一个系统 actor
   * （`actorKind: 'api'`）。硬塞一个假的 membershipId 会让审计流水
   * 指向一个真实存在的人，而那个人什么都没做过。
   *
   * 需要「操作人是谁」的命令（打卡、代打卡、日结封账）自己断言非 null，
   * 那正好把「这条命令必须有人在场」这件事写进了代码。
   */
  membershipId: string | null;
  permissions: ReadonlySet<Permission>;
  /** 'user' = 人在操作；'ai' = 副驾代操作（权限已收窄为操作人的子集） */
  actorKind: 'user' | 'ai' | 'system' | 'api' | 'platform';
  locale: Locale;
  /** 门店时区，用于营业日边界计算 */
  timezone: string;
  ip?: string;
  userAgent?: string;
  /** 设备 actor 的持久化标识。只由服务端验过设备令牌后注入。 */
  deviceId?: string;
  /** Server-only voice identity from authenticated provider system headers, never command input. */
  voiceCall?: { caller: string; startedAt: string };
  verifiedBookingCaller?: {
    phoneE164: string;
    expectedStartsAt: string;
    expectedRescheduleCount: number;
  };
}

/**
 * 断言这条命令背后有人。
 *
 * 「给自己打卡」「只看我自己的收入」这类命令，语义上要求一个具体的人 ——
 * 系统 actor（AI 电话）调它们没有意义。与其在每处写 `ctx.membershipId!`
 * 把类型糊过去，不如在这里断一次：**类型报错本身就是在提醒
 * 「这条命令必须有人在场」**，糊掉就把这个信息丢了。
 */
/**
 * 断言这条命令背后有一个**平台账号**（Supabase 用户）。
 *
 * 和 `actingMembership` 是两件事：手机上机的技师**有人在场但没有账号**。
 * 只有真的要动 `users` 那张表、或者要把某个 auth 用户绑到什么东西上的命令，
 * 才需要这一层 —— 其余一律用 membership 表示「谁做的」。
 */
export function actingUser(ctx: CommandContext): string {
  if (!ctx.userId) {
    throw new AppError(ERROR_CODES.PERMISSION_DENIED, {
      details: { reason: 'requires_platform_account', actorKind: ctx.actorKind },
    });
  }
  return ctx.userId;
}

export function actingMembership(ctx: CommandContext): string {
  if (!ctx.membershipId) {
    throw new AppError(ERROR_CODES.PERMISSION_DENIED, {
      details: { reason: 'requires_human_actor', actorKind: ctx.actorKind },
    });
  }
  return ctx.membershipId;
}

/**
 * 取多语言文本。
 *
 * 抽出来是因为它曾经在三个地方各写了一遍，其中一处漏了 `en` 回退，
 * 结果技师名在结账页显示成「—」。回退链只该有一份实现。
 *
 * 顺序：用户语言 → 简体中文 → 英文 → 任意一个有值的 → 占位符。
 * **绝不返回空白** —— 门店里看到空白只会以为系统坏了。
 */
export function pickText(v: unknown, locale: string, fallback = '—'): string {
  if (typeof v === 'string') return v;
  const o = (v ?? {}) as Record<string, string>;
  return o[locale] ?? o['zh-Hans'] ?? o['en'] ?? Object.values(o)[0] ?? fallback;
}

/**
 * 把用户输入的美元金额转成整数分。
 *
 * **不要用 `Number(x) * 100`**：`Number("1.005") * 100` 得到 100.49999999999999，
 * Math.round 之后是 100 而不是 101。金额差一分技师就会来问，
 * 而这种错只在特定小数上出现，测不出来也查不到。
 *
 * 所以纯字符串解析：小数点后补齐/截断到两位，全程整数运算。
 */
export function dollarsToCents(input: string): number {
  const cleaned = input.trim().replace(/[^\d.-]/g, '');
  if (!cleaned || cleaned === '-' || cleaned === '.') return 0;

  const neg = cleaned.startsWith('-');
  const [whole = '0', frac = ''] = cleaned.replace('-', '').split('.');
  // 第三位及以后直接截断，不进位 —— 收银场景多收一分比少收一分更糟
  const cents = Number(whole || '0') * 100 + Number((frac + '00').slice(0, 2));
  return Number.isFinite(cents) ? (neg ? -cents : cents) : 0;
}

/**
 * 把「本该已经是整数」的值强制转成整数 —— 用于 Postgres 的 bigint（驱动以
 * 字符串返回）与接口 JSON 中的整数字段。
 *
 * **不要用裸的 `Number(x)`**：它对 `"10.5"` 会安静地得到 10.5，
 * 而金额一旦出现小数分，后续每一次累加都会把误差带下去，
 * 最终表现为日结对不上账，且查不出是哪一单引入的。
 *
 * 此处的策略是「拒绝而非猜测」：非整数输入直接回退到 fallback，
 * 并在开发环境显式告警 —— 因为这类输入意味着上游契约已经出错，
 * 就地四舍五入只会把问题藏到更远的地方。
 */
export function asInt(value: unknown, fallback = 0): number {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? value : reject(value, fallback);
  }
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^-?\d+$/.test(trimmed)) return trimmed === '' ? fallback : reject(value, fallback);
    const parsed = Number.parseInt(trimmed, 10);
    return Number.isSafeInteger(parsed) ? parsed : reject(value, fallback);
  }
  return fallback;
}

function reject(value: unknown, fallback: number): number {
  if (process.env['NODE_ENV'] !== 'production') {
    console.error(`[money] 期望整数，实际收到 ${JSON.stringify(value)}，已回退为 ${fallback}`);
  }
  return fallback;
}

/**
 * `asInt` 的金额语义别名。
 *
 * 与 `asInt` 行为一致，独立命名只为让「这是一笔钱」在调用点一眼可见 ——
 * 金额与计数混用同一个函数时，评审时很难发现某处把张数当成了分。
 */
export const asCents = asInt;
