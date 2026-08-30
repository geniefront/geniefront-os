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

const E164_RE = /^\+[1-9]\d{7,14}$/;

/** 将各入口的常见号码写法统一成 E.164；无法可靠判断的短号返回 null。 */
export function normalizePhoneE164(input: string): string | null {
  const raw = input.trim();
  if (!raw || /(?:ext(?:ension)?|x|#)\s*\d+\s*$/i.test(raw)) return null;

  const explicitInternational = raw.startsWith('+') || raw.startsWith('00');
  const digits = raw.replace(/\D/g, '');
  let candidate: string;
  if (explicitInternational) {
    candidate = `+${raw.startsWith('00') ? digits.slice(2) : digits}`;
  } else if (digits.length === 10) {
    candidate = `+1${digits}`;
  } else if (digits.length === 11 && digits.startsWith('1')) {
    candidate = `+${digits}`;
  } else {
    candidate = `+${digits}`;
  }
  return E164_RE.test(candidate) ? candidate : null;
}

/** Consistent phone-entry and display formatted as (999) 999-9999. */
export function formatPhoneInput(input: string | null | undefined): string {
  if (!input) return '';
  const raw = String(input).trim();
  const digits = raw.replace(/\D/g, '');
  const explicitInternational = raw.startsWith('+') || raw.startsWith('00');
  const internationalDigits = raw.startsWith('00') ? digits.slice(2) : digits;

  // The shared UI format is North-American national notation. Do not apply it
  // to another country's E.164 number: doing so silently changes +84… into a
  // plausible-looking but unusable US number.
  if (explicitInternational && !internationalDigits.startsWith('1')) {
    return internationalDigits ? `+${internationalDigits.slice(0, 15)}` : '';
  }

  const national = internationalDigits.length > 10 && internationalDigits.startsWith('1')
    ? internationalDigits.slice(1, 11)
    : internationalDigits.slice(0, 10);

  if (national.length === 0) return '';
  if (national.length <= 3) return `(${national}`;
  if (national.length <= 6) return `(${national.slice(0, 3)}) ${national.slice(3)}`;
  return `(${national.slice(0, 3)}) ${national.slice(3, 6)}-${national.slice(6)}`;
}

/** Consistent phone display helper formatted as (999) 999-9999. */
export function formatPhoneDisplay(input: string | null | undefined): string {
  if (!input) return '';
  const formatted = formatPhoneInput(input);
  return formatted || String(input);
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
  actorKind: 'user' | 'ai' | 'system' | 'api';
  locale: Locale;
  /** 门店时区，用于营业日边界计算 */
  timezone: string;
  ip?: string;
  userAgent?: string;
  /** 设备 actor 的持久化标识。只由服务端验过设备令牌后注入。 */
  deviceId?: string;
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
