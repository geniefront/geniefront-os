/**
 * 订阅码：Stripe 之外的第二条计费权威（sql/0120，计划 2026-09-09）
 *
 * ## 这个文件是 license 侧的**唯一**权威写入口
 *
 * 签发即生效（运营台）、店主自助兑换、运营改期、到期回收 —— 四条路
 * 全部调 `applyLicense()`。两处分别写 entitlement 的话，迟早会在
 * 「清零」和「到期」这两件事上漂开，而漂开的表现是
 * **「有的店过期了还能用」** —— 这种 bug 不会报错，只会让我们少收钱。
 *
 * ## 为什么整块（码的生成 + 生效 + 命令）都在 handlers/ 下
 *
 * 两个原因，缺一不可：
 *
 *   1. **写业务表只允许发生在命令处理器里**（宪法第 1 条，
 *      `scripts/lint-guards.sh` 第 9 条会拦）。`applyLicense` 要 update
 *      `billing_accounts`，所以它必须在这儿 —— 同 `handlers/billing.ts`
 *      导出 `appendLedger` 的道理。
 *   2. **循环 import**。`applyLicense` 要用 `handlers/billing.ts` 的
 *      `appendLedger`（账本只有一个入口，宪法第 9 条），而这个 handler 又要用
 *      `applyLicense`。拆成两个文件就是一个环 —— ESM 下它通常能跑，
 *      但一旦哪天有人在模块顶层做点什么，失败方式是「某个 import 是
 *      undefined」，而报错位置离原因很远。
 *
 * ## 明文码在这里出现，且只在这里
 *
 * 生成、规范化、算 sha256 都在本文件；交给数据库的永远只有 hash。
 * 明文只在「签发」那一次响应里返回一次，之后任何地方都取不回来 ——
 * 它是「捡到就能用」的凭证，和 magic link 同一个量级（`signup/activation.ts`）。
 */

import { createHash, randomInt } from 'node:crypto';
import type postgres from 'postgres';
import { AppError, ERROR_CODES, RedeemLicenseCode, type CommandContext } from '@gf/contracts';
import { parseTs } from '@gf/db';
import type { QuotaUnit, Plan } from '@gf/payroll';
import { registerHandler, type HandlerArgs } from '../bus';
import { appendLedger, ensureAccount, type AccountRow } from './billing';

// ─────────────────────────────────────────────────────────────── 码的生成

/**
 * Crockford base32：去掉了 I / L / O / U。
 *
 * 前三个是为了**读**：运营会在微信里把码打给店家，`0/O`、`1/I/l` 是电话里
 * 最常听错的两组。`U` 去掉是 Crockford 原本的理由（避免拼出脏词）。
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** 4 组 × 5 位 = 20 位 base32 = 100 bit 熵。爆破不可行，而且兑换还有限频 */
const GROUPS = 4;
const GROUP_LEN = 5;

/**
 * 生成一张明文码：`GF-XXXXX-XXXXX-XXXXX-XXXXX`。
 *
 * ⚠️ 用 `randomInt`（CSPRNG）而不是 `Math.random()`。这不是洁癖：
 * `Math.random()` 的状态可以被少量输出反推，而这段字符串的含义是
 * 「一家门店的付费服务」。
 */
export function generateLicenseCode(): string {
  const groups: string[] = [];
  for (let g = 0; g < GROUPS; g += 1) {
    let s = '';
    for (let i = 0; i < GROUP_LEN; i += 1) s += ALPHABET[randomInt(ALPHABET.length)];
    groups.push(s);
  }
  return `GF-${groups.join('-')}`;
}

/**
 * 规范化：大小写、分隔符、以及三组最容易看错的字符。
 *
 * ⭐ `O→0`、`I→1`、`L→1` 的映射必须在**算 hash 之前**做，而且签发与兑换
 * 走同一个函数 —— 否则店家把 `0` 读成 `O` 打进来就是一句「码无效」，
 * 而他手上那张纸明明是对的。
 */
export function normalizeLicenseCode(raw: string): string {
  const body = raw
    .toUpperCase()
    .replace(/^GF/, '')
    .replace(/[^A-Z0-9]/g, '')
    // ⚠️ 只映射字母表里**不存在**的那三个：O / I / L。
    // Q 和 V 是合法字符（Crockford 只去掉 I L O U），把它们也映射掉
    // 会让一张真码永远兑不出来 —— 而错误信息是「码无效」，查不到头绪。
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  return `GF${body}`;
}

export function hashLicenseCode(raw: string): string {
  return createHash('sha256').update(normalizeLicenseCode(raw)).digest('hex');
}

/** 运营台检索用的可见前缀。20 位里只露 4 位，剩下 80 bit 仍然是秘密 */
export function licenseCodePrefix(plain: string): string {
  return `GF-${normalizeLicenseCode(plain).slice(2, 6)}`;
}

// ─────────────────────────────────────────────────────────── 生效的四种形态

export type LicenseTerms =
  /**
   * 订阅码 / 开店码：买 `durationDays` 天的 `plan`。
   *
   * `amountCents` = 这张码私下收了多少钱。只做**留档**（宪法第 4 条：
   * 这笔钱根本没进过我们的系统），用途有两个：写一行发票让老板的账目连续，
   * 以及月底和微信 / 银行流水对总额。
   */
  | {
      kind: 'subscription' | 'store_open';
      plan: Plan; durationDays: number; amountCents: number | null;
    }
  /** 额度包：加一笔额度，走 credit_ledger */
  | { kind: 'quota_pack'; unit: QuotaUnit; amount: number; paidCents: number | null }
  /** 运营改期：直接给一个绝对到期时刻 */
  | { kind: 'period_set'; periodEnd: Date }
  /**
   * 运营延期 / 缩期。
   *
   * 起点一律是 `max(now, 现有到期)`，负数就从那个起点往回缩。
   * ⚠️ 不用「现有到期」当起点：一家已经过期三个月的店，运营点「延 30 天」
   * 想要的是「从今天起还能用一个月」，而不是一个仍然在过去的日期
   * —— 后者的表现是「点了延期但还是过期」，而且看不出为什么。
   */
  | { kind: 'period_extend'; days: number }
  /** 运营收回：当场到期 */
  | { kind: 'period_revoke' };

export interface LicenseSnapshot {
  billingSource: string;
  plan: string;
  subscriptionStatus: string;
  licensePeriodEnd: string | null;
}

export interface LicenseEffect {
  kind: LicenseTerms['kind'];
  before: LicenseSnapshot;
  after: LicenseSnapshot;
  /** 额度包才有 */
  unit?: QuotaUnit;
  amount?: number;
  ledgerId?: string;
  balanceAfter?: number;
  /** 这次是不是把套餐内已用额度清了零（第一次挂上订阅码时） */
  includedReset?: boolean;
}

const snapshot = (row: AccountRow): LicenseSnapshot => ({
  billingSource: row.billing_source,
  plan: row.plan,
  subscriptionStatus: row.subscription_status,
  licensePeriodEnd: row.license_period_end === null
    ? null : parseTs(row.license_period_end).toISOString(),
});

/**
 * 到期时刻 → 订阅状态。
 *
 * 只有两个取值：还没到就是 `active`，到了就是 `expired`。
 * ⚠️ 不复用 `past_due` —— 那句话的意思是「你的卡扣不上」，而对一个
 * 微信转账的店家来说这是错的信息（迁移 0120 的长注释）。
 */
export const licenseStatusFor = (periodEnd: Date, now = new Date()): 'active' | 'expired' =>
  periodEnd.getTime() > now.getTime() ? 'active' : 'expired';

/**
 * 这一行现在由 Stripe 说了算吗？
 *
 * `canceled` 也算 —— 老板随时可能在客户门户里恢复那条订阅，
 * 那一刻 webhook 会把状态写回来。把它当成「没人管」而直接挂上订阅码，
 * 结果是两个权威同时生效，谁最后一次写库谁赢。
 */
const stripeOwnsRow = (row: AccountRow): boolean =>
  row.billing_source === 'stripe' && row.stripe_subscription_id !== null;

/**
 * license 权威下的写入。**所有 license 侧的付费状态变更只走这里。**
 *
 * @param opts.codeId 这次生效对应哪张码（运营改期没有码）
 */
export async function applyLicense(
  tx: postgres.TransactionSql,
  ctx: Pick<CommandContext, 'orgId' | 'locationId'>,
  terms: LicenseTerms,
  opts: {
    codeId?: string | null;
    reason?: string | null;
    now?: Date;
    /**
     * ⚠️ **只有 `switchStoreToLicense` 可以传 true**，而且必须在 Stripe 那边
     * 真的把这家店的 item 删掉（或整条订阅取消掉）之后才传。
     *
     * 它跳过的是下面那道权威冲突检查。跳过而 Stripe 侧没停的话，
     * 这家店会**同时**被 Stripe 按月扣款和被订阅码续期 —— 两个权威都以为
     * 自己说了算，而客户每月照扣的那笔钱没有任何界面解释得清。
     */
    detachedFromStripe?: boolean;
  } = {},
): Promise<LicenseEffect> {
  const now = opts.now ?? new Date();
  const acct = await ensureAccount(tx, ctx, { forUpdate: true });
  const before = snapshot(acct);

  /*
   * ⭐ 额度包**不受权威约束**：它只往账本里加一笔，不改「谁说了算」。
   * 一家正在用 Stripe 订阅的店，照样可以用现金买一包语音分钟。
   * 把它一起挡掉的话，最想额外付钱的那批客户反而买不到东西。
   */
  if (terms.kind === 'quota_pack') {
    const applied = await appendLedger(tx, ctx, acct, {
      kind: 'topup',
      unit: terms.unit,
      amount: terms.amount,
      source: 'license',
      paidCents: terms.paidCents,
      // ⚠️ 只写前缀与收款说明，不写明文（明文在这一层之外就已经不存在了）。
      // 条件展开而不是 `reason: x ?? undefined` —— tsconfig 开了
      // exactOptionalPropertyTypes，显式的 undefined 不等于「没这个键」
      ...(opts.reason ? { reason: opts.reason } : {}),
    });
    return {
      kind: terms.kind,
      before,
      after: before,
      unit: terms.unit,
      amount: terms.amount,
      ledgerId: applied.ledgerId,
      balanceAfter: applied.balanceAfter,
    };
  }

  // 权威冲突：Stripe 还在管这一行 → 必须先走切换（先删那家店的 subscription
  // item，见 stripe/routes.ts 的 switch-to-license），不能两边同时生效
  if (stripeOwnsRow(acct) && opts.detachedFromStripe !== true) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: {
        reason: 'stripe_active_switch_required',
        subscriptionStatus: acct.subscription_status,
      },
    });
  }

  let periodEnd: Date;
  let plan = acct.plan;
  let includedReset = false;

  /** 续期 / 延期的起点：还没到期就从原到期日接着算，已经过期就从现在算 */
  const extendBase = (): Date => {
    const existing = acct.billing_source === 'license' && acct.license_period_end !== null
      ? parseTs(acct.license_period_end)
      : null;
    return existing !== null && existing.getTime() > now.getTime() ? existing : now;
  };

  if (terms.kind === 'period_revoke') {
    periodEnd = now;
  } else if (terms.kind === 'period_set') {
    periodEnd = terms.periodEnd;
  } else if (terms.kind === 'period_extend') {
    periodEnd = new Date(extendBase().getTime() + terms.days * 86_400_000);
  } else {
    /*
     * ⭐ **续期是叠加，不是覆盖。**
     *
     * 提前续费的店最常见：还剩 10 天时又转了一笔钱。起点取
     * `max(now, 现有到期)`，那 10 天就留住了；直接从 now 起算等于把他
     * 已经付过的 10 天没收掉 —— 而他会在到期那天才发现，然后我们无法解释。
     *
     * ⚠️ 只在**当前权威已经是 license** 时才叠加（见 `extendBase`）。
     * 从 stripe/none 切过来的那一行上 `license_period_end` 可能是上一轮
     * 留下的旧值，接着它算等于白送一段时间。
     */
    periodEnd = new Date(extendBase().getTime() + terms.durationDays * 86_400_000);
    plan = terms.plan;

    /*
     * 第一次挂上订阅码 = 一个新账期的开始 → 套餐内已用额度清零。
     *
     * ⚠️ 只在「切换权威」这一刻清，续期时**不清**。续期时也清的话，
     * 一个月内转两次钱的店会白拿两份套餐内额度；而 license 模式下的
     * 常规清零由 `ops/licenseSweep.ts` 按 30 天边界滚动（那里有长注释）。
     */
    includedReset = acct.billing_source !== 'license';
  }

  const status = licenseStatusFor(periodEnd, now);
  const iso = periodEnd.toISOString();

  await tx`
    update billing_accounts set
      billing_source = 'license',
      plan = ${plan},
      subscription_status = ${status},
      license_period_end = ${iso},
      -- license 模式下两列镜像同一个值：展示逻辑（queries/billing.ts、
      -- apps/web 的 subscriptionNotice）不必为第二种权威分叉
      current_period_end = ${iso},
      license_code_id = ${opts.codeId ?? acct.license_code_id ?? null},
      -- 新账期 → 到期提醒的去重标记要清掉，否则下一轮到期前那封信不会发
      license_expiry_notified_at = ${status === 'active' ? null : acct.license_expiry_notified_at},
      -- 订阅码没有「期末取消」这回事：那两列是 Stripe 客户门户的产物。
      -- 留着旧值的话，界面会一直显示「到期即止」而事实是刚续了一年
      cancel_at_period_end = false,
      cancel_at = null,
      included_credits_used = ${includedReset ? 0 : acct.included_credits_used},
      included_minutes_used = ${includedReset ? 0 : acct.included_minutes_used},
      included_period_start = ${includedReset ? now.toISOString() : acct.included_period_start},
      stripe_subscription_item_id = null
    where id = ${acct.id}`;

  return {
    kind: terms.kind,
    before,
    after: {
      billingSource: 'license',
      plan,
      subscriptionStatus: status,
      licensePeriodEnd: iso,
    },
    includedReset,
  };
}

// ────────────────────────────────────────────────── 兑换：认领 + 回填结果

export interface ClaimedLicense {
  codeId: string;
  redemptionId: string;
  kind: 'subscription' | 'quota_pack' | 'store_open';
  codePrefix: string;
  plan: string | null;
  durationDays: number | null;
  unit: QuotaUnit | null;
  amount: number | null;
  amountCents: number | null;
  paymentNote: string;
}

/**
 * 认领一张码（sql/0120 的 `gf_license_claim`）。
 *
 * ⚠️ **失败原因一律收敛成一个 `code_invalid`**。区分「不存在 / 已用过 /
 * 已撤销 / 过了兑换期」的话，这个接口就成了一个可以拿来枚举码的探针 ——
 * 而它是未登录门槛最低的那种凭证。
 */
export async function claimLicense(
  tx: postgres.TransactionSql,
  plainCode: string,
): Promise<ClaimedLicense> {
  let row: { t: ClaimedLicense } | undefined;
  try {
    [row] = await tx<{ t: ClaimedLicense }[]>`
      select gf_license_claim(${hashLicenseCode(plainCode)}) as t`;
  } catch (e) {
    const code = (e as { code?: string }).code;
    // 42501 = 租户上下文缺失，那是我们自己的编排错误，不是一张坏码
    if (code === '42501') throw e;
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, { details: { reason: 'code_invalid' } });
  }
  if (!row?.t) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, { details: { reason: 'code_invalid' } });
  }
  return row.t;
}

/** 把生效结果写回兑换记录。和 `claimLicense` 必须在同一个事务里 */
export async function recordLicenseEffect(
  tx: postgres.TransactionSql,
  redemptionId: string,
  effect: LicenseEffect,
): Promise<void> {
  await tx`
    select gf_license_record_effect(${redemptionId}::uuid, ${JSON.stringify(effect)}::jsonb)`;
}

/**
 * 一张已认领的码 → `applyLicense` 吃的那份条款。
 *
 * 抽出来是因为店主兑换与运营代兑走的是**同一份**转换 ——
 * 抄两遍就会有一天两边对 `durationDays` 缺失的处理不一致。
 */
export function termsFromClaim(claim: ClaimedLicense): RedeemableTerms {
  if (claim.kind === 'quota_pack') {
    if (claim.unit === null || claim.amount === null) {
      throw new AppError(ERROR_CODES.INTERNAL, {
        details: { reason: 'license_terms_incomplete', codeId: claim.codeId },
      });
    }
    return {
      kind: 'quota_pack', unit: claim.unit, amount: claim.amount, paidCents: claim.amountCents,
    };
  }
  if (claim.plan === null || claim.durationDays === null) {
    throw new AppError(ERROR_CODES.INTERNAL, {
      details: { reason: 'license_terms_incomplete', codeId: claim.codeId },
    });
  }
  return {
    kind: claim.kind,
    plan: claim.plan as Plan,
    durationDays: claim.durationDays,
    amountCents: claim.amountCents,
  };
}

/**
 * 一张**码**能生效成的那几种条款。
 *
 * 排除 `period_set` / `period_extend` / `period_revoke` —— 那三种是运营
 * 直接改账户，没有码、也没有钱经手（所以也不写发票）。分出这个类型是为了让
 * 发票那一段能安心读 `plan` / `durationDays`，而不是靠一串 `in` 判断。
 */
export type RedeemableTerms =
  Extract<LicenseTerms, { kind: 'subscription' | 'store_open' | 'quota_pack' }>;

// ─────────────────────────────────────────────────── 私下收款也要有一行发票

/**
 * 给一次私下收款写一行 `billing_invoices`（计划批 7）。
 *
 * ## 为什么必须写
 *
 * 走 Stripe 的店，发票那一页是 webhook 落下来的（`billing.recordInvoice`）。
 * 而微信 / 支付宝 / 现金付款的店在那一页上**什么都没有** —— 于是
 * 「上个月那 ¥1500 有没有单据」这个问题在系统里没有答案，
 * 而这恰恰是老板年底做账时一定会问的那一个。
 *
 * ## ⚠️ 正文里不写 `payment_note`
 *
 * 那一行是**运营的内部收款说明**（「张老板代付三家店，打了个折」这类），
 * 收件人是我们自己，不是店主。把它原样搬到店主看得见的发票列表上，
 * 迟早会泄露一句不该他看到的话。发票正文只写「买了什么」，
 * 出处仍然只存在 `license_codes.payment_note` 与审计里。
 *
 * ## 幂等
 *
 * 每张码在每家店只能兑一次（`license_redemption_once`），而这一行是在同一个
 * 事务里跟着兑换写的 —— 兑换重放不到这里，所以不需要额外的幂等键。
 * `invoice_number` 用 `LIC-<codeId 前 8 位>`：一张码一个号，人能对得上。
 */
async function writeLicenseInvoice(
  tx: postgres.TransactionSql,
  ctx: Pick<CommandContext, 'orgId' | 'locationId'>,
  args: {
    codeId: string; codePrefix: string; amountCents: number;
    terms: RedeemableTerms; periodEndIso: string | null; now: Date;
  },
): Promise<string | null> {
  if (args.amountCents <= 0) return null;

  /*
   * 语言取**组织**的默认语言（`organizations.default_locale`）——
   * 门店表没有这一列，而发票是给老板看的（同 `email/ownerShop.ts` 的判断）。
   * 取不到就退回英文：一行发票的语言选错，比因为一次 join 失败而
   * 整行发票不写要轻得多。
   */
  const [org] = await tx<{ locale: string | null }[]>`
    select default_locale as locale from organizations where id = ${ctx.orgId}`;
  const zh = (org?.locale ?? 'en').startsWith('zh');

  const day = (d: Date): string => d.toISOString().slice(0, 10);
  const today = day(args.now);

  let description: string;
  let period: string;
  if (args.terms.kind === 'quota_pack') {
    const unitText = args.terms.unit === 'credit'
      ? (zh ? '积分' : 'credits') : (zh ? '语音分钟' : 'voice minutes');
    description = zh
      ? `额度包 ${args.codePrefix} · ${args.terms.amount} ${unitText}`
      : `Credit pack ${args.codePrefix} · ${args.terms.amount} ${unitText}`;
    // 额度包不过期，没有账期这回事 —— 写兑换当天，别编一段假的区间
    period = today;
  } else {
    const planLabel = args.terms.plan === 'growth' ? 'Growth' : 'Essential';
    description = zh
      ? `订阅码 ${args.codePrefix} · ${planLabel} ${args.terms.durationDays} 天`
      : `License ${args.codePrefix} · ${planLabel} ${args.terms.durationDays} days`;
    period = args.periodEndIso === null
      ? today : `${today} – ${day(new Date(args.periodEndIso))}`;
  }

  const [row] = await tx<{ id: string }[]>`
    insert into billing_invoices
      (org_id, location_id, invoice_number, period, description,
       amount_cents, status, date, stripe_invoice_id, hosted_invoice_url)
    values (${ctx.orgId}, ${ctx.locationId},
            ${`LIC-${args.codeId.replace(/-/g, '').slice(0, 8).toUpperCase()}`},
            ${period}, ${description}, ${args.amountCents},
            -- 钱已经到账了才会有码，所以直接是 paid。
            -- ⚠️ stripe id 与托管发票页都是 null：这一笔 Stripe 那边不存在，
            -- 界面上「查看发票」因此没有可跳的地方（前端据此不显示那个链接）
            'paid', ${today}, null, null)
    returning id`;
  return row!.id;
}

/**
 * 一张已认领的码 → 生效 + 回填 + 发票，**一个事务里的三件事**。
 *
 * ⭐ 四条路（店主自助兑换、运营代挂、Stripe 切换、运营开店）全部走这里。
 * 之前它们各自写「apply → recordEffect」两行，第三件事（发票）一加进来
 * 就是四处各抄一遍 —— 而漏抄的那一处的表现是「这家店的发票页少一行」，
 * 没人会当成 bug 报上来。
 */
export async function redeemClaimedLicense(
  tx: postgres.TransactionSql,
  ctx: Pick<CommandContext, 'orgId' | 'locationId'>,
  claim: ClaimedLicense,
  opts: {
    /** 进账本与审计的那句话。⚠️ 不进发票正文（见 `writeLicenseInvoice`） */
    reason?: string | null;
    /** 只有 `switchStoreToLicense` 在 Stripe 侧真的停掉之后才传 true */
    detachedFromStripe?: boolean;
    now?: Date;
  } = {},
): Promise<LicenseEffect & { invoiceId: string | null }> {
  const now = opts.now ?? new Date();
  const terms = termsFromClaim(claim);

  const effect = await applyLicense(tx, ctx, terms, {
    codeId: claim.codeId,
    reason: opts.reason ?? null,
    now,
    ...(opts.detachedFromStripe === true ? { detachedFromStripe: true } : {}),
  });
  await recordLicenseEffect(tx, claim.redemptionId, effect);

  const invoiceId = claim.amountCents === null ? null : await writeLicenseInvoice(tx, ctx, {
    codeId: claim.codeId,
    codePrefix: claim.codePrefix,
    amountCents: claim.amountCents,
    terms,
    periodEndIso: effect.after.licensePeriodEnd,
    now,
  });

  return { ...effect, invoiceId };
}

// ────────────────────────────────────────────────────── 店主自助兑换（命令）

/**
 * 兑换一张运营签发的订阅码 / 额度包码。
 *
 * ## 这条命令为什么可以在「欠费冻结」时执行
 *
 * `bus.ts` 的 `WRITE_ALLOWED_WHILE_PAST_DUE` 已经放行 `billing.` 前缀，
 * 所以一家到期被冻成只读的店**能兑一张码把自己救回来**。
 * 这不是漏网，是那份白名单本来的语义：欠费时唯一还该能做的写操作，
 * 就是把欠费这件事解决掉。⚠️ 不要为这条命令另加白名单。
 */
registerHandler(RedeemLicenseCode, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof RedeemLicenseCode.input._type>) => {
  const claim = await claimLicense(tx, input.code);
  const effect = await redeemClaimedLicense(tx, ctx, claim, {
    // ⚠️ 账本与审计里只留**前缀**。明文码到这一行为止就不存在了
    reason: `license:${claim.codePrefix}`,
  });

  audit({
    entityType: 'billing_account',
    entityId: ctx.locationId,
    before: effect.before,
    after: {
      ...effect.after,
      kind: claim.kind,
      codePrefix: claim.codePrefix,
      codeId: claim.codeId,
      unit: effect.unit ?? null,
      amount: effect.amount ?? null,
      // 私下收款那一行发票（计划批 7）。null = 这张码没写面值
      invoiceId: effect.invoiceId,
    },
  });

  return {
    kind: claim.kind,
    codePrefix: claim.codePrefix,
    plan: claim.kind === 'quota_pack' ? null : effect.after.plan,
    periodEnd: claim.kind === 'quota_pack' ? null : effect.after.licensePeriodEnd,
    unit: (effect.unit ?? null) as QuotaUnit | null,
    amount: effect.amount ?? null,
    balanceAfter: effect.balanceAfter ?? null,
    invoiceId: effect.invoiceId,
  };
});
