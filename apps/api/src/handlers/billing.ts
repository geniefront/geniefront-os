/**
 * 计费命令的实现（Phase 2，决策 8）
 *
 * 这个文件里**一行 Stripe 调用都没有**。所有和 Stripe 说话的编排在
 * `apps/api/src/stripe/routes.ts`，理由写在 `commands/billing.ts` 顶部：
 * 命令跑在数据库事务里，把几秒的外部 IO 塞进事务会占住连接和快照。
 *
 * 分工是：**路由调 Stripe，命令落库。** 每一次额度变动仍然是一条
 * 有审计、有幂等、有 RLS 的命令（宪法第 1 条）。
 *
 * 三条纪律，每一条都在下面有对应的代码：
 *
 *   1. **额度只用整数**（宪法第 4 条的同一条精神）。全程不出现浮点。
 *   2. **扣额度永远走 `credit_ledger`**，不许直接 update 余额 ——
 *      直接改的那一刻，「我的积分去哪了」就变成一个没有答案的问题。
 *   3. **算额度的判断全在 `@gf/payroll/credits` 的纯函数里**（宪法第 2 条），
 *      这里只负责取数、写库、留痕。
 *
 * ⚠️ **两种额度不能互换**，这个文件里没有任何换算（决策 8）。
 */

import {
  ConfirmOwnershipPayment, SetAutoTopup, SyncSubscription, SavePaymentMethod,
  RecordTopup, ClaimAutoTopup, RecordTopupFailure,
  BillingChangePlan, BillingBuyAddon, BillingSaveTaxProfile,
  RecordInvoice, RecordTopupReversal,
  AppError, ERROR_CODES, type CommandContext,
} from '@gf/contracts';
import { ts } from '@gf/db';
import {
  shouldAutoTopup, applyEntry, unitsPerTopup, includedFor,
  MAX_TOPUP_FAILURES, TOPUP_COOLDOWN_MS, TOPUP_PRICE_CENTS,
  type QuotaUnit, type AutoTopupState, type LedgerEntryInput,
} from '@gf/payroll';
import { registerHandler, type HandlerArgs } from '../bus';
import type postgres from 'postgres';

export interface AccountRow {
  id: string;
  /** 兄弟门店广播要用（多店共用一条订阅时按 location 分派 item） */
  org_id: string;
  location_id: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  stripe_subscription_item_id: string | null;
  plan: string;
  subscription_status: string;
  current_period_end: string | Date | null;
  cancel_at_period_end: boolean;
  cancel_at: string | Date | null;
  trial_ends_at: string | Date | null;
  trial_will_end_notified_at: string | Date | null;
  default_payment_method_id: string | null;
  payment_method_label: string | null;

  credit_balance: number;
  voice_minute_balance: number;
  included_credits_used: number;
  included_minutes_used: number;
  manual_voice_minutes: number | null;
  included_period_start: string | Date | null;

  auto_topup_credits_enabled: boolean;
  auto_topup_credits_threshold: number;
  auto_topup_credits_last_at: string | Date | null;
  auto_topup_credits_failures: number;
  auto_topup_minutes_enabled: boolean;
  auto_topup_minutes_threshold: number;
  auto_topup_minutes_last_at: string | Date | null;
  auto_topup_minutes_failures: number;

  // ── 第二条计费权威（迁移 0120）────────────────────────────────────────
  /** none | stripe | license。⭐ 一行账户只有一个权威 */
  billing_source: string;
  license_period_end: string | Date | null;
  license_code_id: string | null;
  license_expiry_notified_at: string | Date | null;
}

/**
 * 每种额度在账户行上对应哪几列。
 *
 * ⭐ 集中成一张表，是为了让「加一种额度」变成改一处而不是改二十处 ——
 * 而更重要的是：**两种额度的处理必须一模一样**，散在各处写两遍
 * 迟早会漂移成「积分有冷却而分钟没有」这种只在半夜出现的 bug。
 */
const COLS: Record<QuotaUnit, {
  balance: string; includedUsed: string;
  enabled: string; threshold: string; lastAt: string; failures: string;
}> = {
  credit: {
    balance: 'credit_balance', includedUsed: 'included_credits_used',
    enabled: 'auto_topup_credits_enabled', threshold: 'auto_topup_credits_threshold',
    lastAt: 'auto_topup_credits_last_at', failures: 'auto_topup_credits_failures',
  },
  voice_minute: {
    balance: 'voice_minute_balance', includedUsed: 'included_minutes_used',
    enabled: 'auto_topup_minutes_enabled', threshold: 'auto_topup_minutes_threshold',
    lastAt: 'auto_topup_minutes_last_at', failures: 'auto_topup_minutes_failures',
  },
};

export const balanceOf = (row: AccountRow, unit: QuotaUnit): number =>
  unit === 'credit' ? row.credit_balance : row.voice_minute_balance;

export const includedUsedOf = (row: AccountRow, unit: QuotaUnit): number =>
  unit === 'credit' ? row.included_credits_used : row.included_minutes_used;

/**
 * ⭐ 在不在试用期，**看 `trial_ends_at` 是不是还在未来，不看 status**。
 *
 * Stripe 的 `trialing` 状态在扣款那一刻就变成 `active`，但我们本地这行
 * 要等 webhook 回来才更新 —— 中间那几秒如果按 status 判，
 * 客户会短暂拿到试用额度而不是他刚付钱买的那一档。
 */
export const isTrialing = (row: Pick<AccountRow, 'trial_ends_at'>, now = new Date()): boolean =>
  row.trial_ends_at !== null && new Date(ts(row.trial_ends_at)).getTime() > now.getTime();

/**
 * ⭐ 本期套餐内额度的总数。**这是唯一一处判据。**
 *
 * 三档，顺序不能反：
 *   · `none`（从未接过计费）→ **0**。计费账户行会在任何一次记账时被自动
 *     建出来，默认状态原来是 `trialing` —— 于是一家从没进过 Stripe 的门店
 *     会按 essential 档白拿 500 积分 + 60 语音分钟，而且因为
 *     `current_period_end` 为空还永不清零（sql/0085）
 *   · 试用期 → 试用档（150 / 20），不是整档套餐
 *   · 其余 → 套餐档
 */
export const includedTotalOf = (row: AccountRow, unit: QuotaUnit): number =>
  (row.subscription_status === 'none' ? 0 : includedFor(row.plan, unit, isTrialing(row),
    row.manual_voice_minutes ?? null, row.billing_source));

export const includedRemainingOf = (row: AccountRow, unit: QuotaUnit): number =>
  Math.max(0, includedTotalOf(row, unit) - includedUsedOf(row, unit));

/** postgres.js 回来的 timestamptz 可能是字符串（见 @gf/db 的 parseTs 注释） */
const toDate = (v: string | Date | null): Date | null => {
  if (v === null) return null;
  if (typeof v !== 'string') return v;
  return new Date(v.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'));
};

/**
 * 拿这家店的计费账户，没有就建一个。
 *
 * ⚠️ **一定要自动建**：一家还在试用期、从没进过 Stripe 的店照样会产生
 * AI 用量。没有账户就没法记账，而「用量发生了但账上看不到」是最糟的
 * 那一种 —— 到月底突然冒出一笔对不上的差额。
 *
 * `on conflict do nothing` 而不是先查后插：两个请求同时给一家新店记账时，
 * 先查后插会撞唯一索引，而客户看到的是一个莫名其妙的 500。
 */
export async function ensureAccount(
  tx: postgres.TransactionSql,
  ctx: Pick<CommandContext, 'orgId' | 'locationId'>,
  opts: { forUpdate?: boolean } = {},
): Promise<AccountRow> {
  await tx`
    insert into billing_accounts (org_id, location_id)
    values (${ctx.orgId}, ${ctx.locationId})
    on conflict (location_id) do nothing`;

  const rows = opts.forUpdate
    ? await tx<AccountRow[]>`
        select * from billing_accounts
        where location_id = ${ctx.locationId} for update`
    : await tx<AccountRow[]>`
        select * from billing_accounts where location_id = ${ctx.locationId}`;

  const row = rows[0];
  if (!row) {
    // 插了又查不到，只可能是 RLS 把它挡住了 —— 那是配置事故，不是业务分支
    throw new AppError(ERROR_CODES.INTERNAL, {
      details: { reason: 'billing_account_unreachable', locationId: ctx.locationId },
    });
  }
  return row;
}

/** DB 行 → 纯函数吃的状态。转换只有一份，免得两处各写一遍漂移 */
export function toAutoTopupState(row: AccountRow, unit: QuotaUnit): AutoTopupState {
  const isCredit = unit === 'credit';
  return {
    balance: balanceOf(row, unit),
    enabled: isCredit ? row.auto_topup_credits_enabled : row.auto_topup_minutes_enabled,
    thresholdUnits: isCredit
      ? row.auto_topup_credits_threshold : row.auto_topup_minutes_threshold,
    lastAt: toDate(isCredit ? row.auto_topup_credits_last_at : row.auto_topup_minutes_last_at),
    failures: isCredit ? row.auto_topup_credits_failures : row.auto_topup_minutes_failures,
    defaultPaymentMethodId: row.default_payment_method_id,
    subscriptionStatus: row.subscription_status,
    includedRemaining: includedRemainingOf(row, unit),
  };
}

/**
 * 记一笔账并同步余额缓存。**所有额度变动的唯一入口。**
 *
 * 账本是事实，`billing_accounts.*_balance` 只是缓存 —— 每次都从传进来的
 * 余额算，而那个值必须来自 `for update` 锁住的那一行，
 * 否则并发下两笔会算出同一个 balance_after。
 */
export async function appendLedger(
  tx: postgres.TransactionSql,
  ctx: Pick<CommandContext, 'orgId' | 'locationId'>,
  account: AccountRow,
  entry: LedgerEntryInput & {
    source?: string | null;
    usageEventId?: string | null;
    stripePaymentIntentId?: string | null;
    paidCents?: number | null;
  },
): Promise<{ ledgerId: string; balanceAfter: number }> {
  // 纯函数把关：方向和类型对不上（「充值 −1000」）、调账没写原因、
  // 不是整数 —— 全在这里被挡下，而不是等 DB 约束报一句看不懂的话
  const applied = applyEntry(balanceOf(account, entry.unit), entry);

  const [row] = await tx<{ id: string }[]>`
    insert into credit_ledger
      (org_id, location_id, kind, unit, amount, balance_after, paid_cents,
       amount_cents, balance_after_cents,
       source, usage_event_id, stripe_payment_intent_id, reason)
    values (${ctx.orgId}, ${ctx.locationId}, ${entry.kind}, ${entry.unit},
            ${entry.amount}, ${applied.balanceAfter}, ${entry.paidCents ?? null},
            -- ⚠️ 钱那两列是上一版留下的，从 0023 起不再有意义 → 写 **null**。
            -- 写 0 是错的：0 的意思是「这笔金额是零」，而事实是
            -- 「这一笔跟钱没关系」——对账时会被读成完全不同的意思（迁移 0024）
            null, null,
            ${entry.source ?? null}, ${entry.usageEventId ?? null},
            ${entry.stripePaymentIntentId ?? null}, ${entry.reason ?? null})
    returning id`;

  const col = COLS[entry.unit].balance;
  await tx`
    update billing_accounts set ${tx(col)} = ${applied.balanceAfter}
    where id = ${account.id}`;

  return { ledgerId: row!.id, balanceAfter: applied.balanceAfter };
}

// ─────────────────────────────────────────────────────────── 自动续充设置

registerHandler(SetAutoTopup, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof SetAutoTopup.input._type>) => {
  const acct = await ensureAccount(tx, ctx, { forUpdate: true });
  const unit = input.unit as QuotaUnit;
  const c = COLS[unit];
  const state = toAutoTopupState(acct, unit);

  /**
   * 重新打开时把失败计数清零。
   *
   * 老板来动这个开关，通常正是因为他刚换了张卡 —— 还揣着上一张卡的
   * 三次失败不放，等于他明明修好了却还是充不上，而界面上不会告诉他为什么。
   */
  const reopening = input.enabled && !state.enabled;
  const failuresReset = reopening && state.failures > 0;

  await tx`
    update billing_accounts set
      ${tx(c.enabled)} = ${input.enabled},
      ${tx(c.threshold)} = ${input.thresholdUnits},
      ${tx(c.failures)} = ${failuresReset ? 0 : state.failures}
    where id = ${acct.id}`;

  audit({
    entityType: 'billing_account', entityId: acct.id,
    before: { unit, enabled: state.enabled, thresholdUnits: state.thresholdUnits },
    after: { unit, enabled: input.enabled, thresholdUnits: input.thresholdUnits, failuresReset },
  });

  return {
    unit: input.unit,
    enabled: input.enabled,
    thresholdUnits: input.thresholdUnits,
    failuresReset,
  };
});

// ───────────────────────────────────────────────────────────── 订阅状态同步

/** 一份订阅事实，落到**一行**账户上。同一条订阅上的每家店各算一份 */
interface SubscriptionPatch {
  customerId: string | null;
  subscriptionId: string | null;
  subscriptionItemId: string | null;
  status: string;
  plan: string;
  periodEnd: string | null;
  trialEndsAt: string | null;
  cancelAtPeriodEnd: boolean;
  cancelAt: string | null;
}

/**
 * 把一份订阅事实写进一行账户，并回答「这次算不算续期」。
 *
 * 抽出来是因为**多店共用同一条订阅**：一条 `customer.subscription.updated`
 * 要同时落到这条订阅上的每一家店。写两遍的话，续期清零、试用提醒去重
 * 这些判断迟早会在两处漂开，而漂开的表现是「有的店清零了有的没清」。
 */
async function applySubscriptionToRow(
  tx: postgres.TransactionSql,
  row: AccountRow,
  patch: SubscriptionPatch,
  scope: { isAnchor: boolean; namedInItems: boolean },
): Promise<{ renewed: boolean; skipped: boolean }> {
  /**
   * ⭐⭐ **由订阅码接管的行不接受 Stripe 事件**（迁移 0120）。
   *
   * ## 不加这一条会怎样
   *
   * 多店经营共用同一条订阅，而退订之后 `stripe_subscription_id` 是**留着的**
   * （webhook 靠它定位租户）。于是一家已经改用订阅码的店，仍然会被下面那段
   * 兄弟门店查询按 `stripe_subscription_id` 捞出来 —— 一条
   * `customer.subscription.updated` 就把它的状态和到期日**静默改回** Stripe 那一份。
   *
   * 表现是：这家店明明续到年底，某天早上突然显示欠费。没有任何报错，
   * 而且只在老板名下还有别的店时才发生。
   *
   * ## 什么时候算「老板自己回去付费了」（接管，切回 stripe 权威）
   *
   * 两种证据，任一成立：
   *   · 事件的 item 映射里**点名了这家店**（`/v1/billing/add-store` 建 item 时
   *     写了 `gf_location_id`）—— 那是有人明确把这家店挂到订阅上；
   *   · 它是本次事件解析出的**锚点店**，而且事件带的订阅 id 和这一行记着的
   *     **不是同一条** —— 新走一次 Checkout 会建出一条新订阅，这就是它。
   *
   * 反过来，同一条旧订阅的后续事件（id 相同、没点名）一律跳过。
   */
  const takeover = scope.namedInItems
    || (scope.isAnchor
      && patch.subscriptionId !== null
      && patch.subscriptionId !== row.stripe_subscription_id);
  if (row.billing_source === 'license' && !takeover) {
    return { renewed: false, skipped: true };
  }
  /**
   * 试用结束时刻变了 = 换了一段试用，提醒信的去重标记要跟着清掉。
   *
   * ⚠️ **按毫秒比，不能按字符串比。** 入参是 ISO 串，库里那个是
   * Postgres round-trip 回来的 —— 同一个时刻两边的小数位和时区写法都可能
   * 不一样，字符串比会把「没变」判成「变了」，于是每一条重投的
   * trial_will_end 都会重新发一封信。
   */
  const msOf = (v: string | null): number | null => (v === null ? null : new Date(v).getTime());
  const trialChanged = msOf(patch.trialEndsAt)
    !== msOf(row.trial_ends_at === null ? null : ts(row.trial_ends_at));

  /**
   * ⭐ **续期就把两种套餐内额度都清零。**
   *
   * 清零的时机跟着 Stripe 的 `current_period_end` 走，不自己数日子 ——
   * 自己数就一定会和 Stripe 的账单周期漂开，而漂开之后
   * 「这个月到底还剩几次」谁也说不清，客户和我们各算各的。
   *
   * ⚠️ 只有**往后走**才算续期。Stripe 偶尔会重投一条旧事件，
   * 那条里的 period_end 比库里的早 —— 照着它清零等于白送客户一整期额度。
   */
  const prevEnd = row.current_period_end ? new Date(ts(row.current_period_end)).getTime() : 0;
  const nextEnd = patch.periodEnd ? new Date(patch.periodEnd).getTime() : 0;
  const renewed = nextEnd > prevEnd && prevEnd > 0;

  await tx`
    update billing_accounts set
      stripe_customer_id = ${patch.customerId},
      stripe_subscription_id = ${patch.subscriptionId},
      stripe_subscription_item_id = ${patch.subscriptionItemId},
      plan = ${patch.plan},
      subscription_status = ${patch.status},
      current_period_end = ${patch.periodEnd}::timestamptz,
      cancel_at_period_end = ${patch.cancelAtPeriodEnd},
      cancel_at = ${patch.cancelAt}::timestamptz,
      trial_ends_at = ${patch.trialEndsAt}::timestamptz,
      trial_will_end_notified_at = ${trialChanged
        ? null : (row.trial_will_end_notified_at === null
          ? null : ts(row.trial_will_end_notified_at))}::timestamptz,
      included_credits_used = ${renewed ? 0 : row.included_credits_used},
      included_minutes_used = ${renewed ? 0 : row.included_minutes_used},
      included_period_start = ${renewed ? tx`now()` : tx`included_period_start`},
      -- 接管：这一行的权威回到 Stripe。清空 subscription id 的事件不算
      -- （那是退订，权威还是 Stripe，只是没订阅了）
      billing_source = ${patch.subscriptionId !== null ? 'stripe' : tx`billing_source`}
    where id = ${row.id}`;

  return { renewed, skipped: false };
}

registerHandler(SyncSubscription, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof SyncSubscription.input._type>) => {
  const acct = await ensureAccount(tx, ctx, { forUpdate: true });

  /**
   * 局部更新，而且 `null` 的含义**按字段分两类**：
   *
   * · **id 类**（customer / subscription）：`null` = 明确清空。
   *   退订之后确实没有订阅 id 了，这时候必须能写回 null。
   * · **枚举类**（plan / status）：`null` = 认不出来，**保持原样**。
   *   ⚠️ `planForPriceId` 认不出一个 price 时返回 null；按「明确清空」处理的话，
   *   一个付 Growth 钱的客户会被静默降档，而账单上完全看不出来。
   */
  const clearable = <T>(next: T | null | undefined, cur: T | null): T | null =>
    next === undefined ? cur : (next ?? null);

  const status = input.subscriptionStatus ?? acct.subscription_status;
  const customerId = clearable(input.stripeCustomerId, acct.stripe_customer_id);
  const subscriptionId = clearable(input.stripeSubscriptionId, acct.stripe_subscription_id);

  // 时间参数一律先转成字符串再配 ::timestamptz（见 @gf/db 的 ts() 注释）
  const isoOf = (v: string | null | undefined, cur: string | Date | null): string | null =>
    v === undefined ? (cur === null ? null : ts(cur)) : (v === null ? null : ts(new Date(v)));

  /**
   * 试用结束时刻。**id 类语义**：`null` = 明确清空。
   *
   * 试用一旦转正，Stripe 的 `trial_end` 就不再出现在订阅对象上，
   * 这时候必须真的写回 null —— 留着旧值的话「这家店试用到什么时候」
   * 在客服那边会得到一个早就过期的答案。
   */
  const trialEndsAt = isoOf(input.trialEndsAt, acct.trial_ends_at);
  const cancelAtPeriodEnd = input.cancelAtPeriodEnd ?? acct.cancel_at_period_end;
  const cancelAt = isoOf(input.cancelAt, acct.cancel_at);

  /**
   * ⭐ 这条订阅上，哪个 item 属于哪家门店。
   *
   * 没有这一份映射时，退化成「所有店共用顶层的 plan / period」——
   * 那正是单店的情形，也是所有历史调用点的形状。
   */
  const itemByLocation = new Map(
    (input.items ?? []).map((it) => [it.locationId, it] as const),
  );

  /** 一行账户该落什么套餐与账期：先看它自己的 item，没有再退回顶层 */
  const patchFor = (row: AccountRow): SubscriptionPatch => {
    const own = itemByLocation.get(row.location_id);
    return {
      customerId,
      subscriptionId,
      subscriptionItemId: own?.subscriptionItemId ?? row.stripe_subscription_item_id ?? null,
      status,
      plan: own?.plan ?? input.plan ?? row.plan,
      periodEnd: own?.currentPeriodEnd !== undefined
        ? isoOf(own.currentPeriodEnd, row.current_period_end)
        : isoOf(input.currentPeriodEnd, row.current_period_end),
      trialEndsAt,
      cancelAtPeriodEnd,
      cancelAt,
    };
  };

  const anchorPatch = patchFor(acct);
  // Setup-mode Checkout only attaches a customer; it does not transfer billing authority.
  if (acct.billing_source === 'license' && input.stripeCustomerId
    && input.stripeSubscriptionId === undefined && input.subscriptionStatus === undefined
    && input.plan === undefined && !input.items?.length) {
    await tx`update billing_accounts set stripe_customer_id=${input.stripeCustomerId} where id=${acct.id}`;
  }
  const anchorResult = await applySubscriptionToRow(tx, acct, anchorPatch, {
    isAnchor: true,
    namedInItems: itemByLocation.has(acct.location_id),
  });
  const renewed = anchorResult.renewed;

  /**
   * ⭐ **兄弟门店。** 多店经营共用同一条订阅（一个老板一张卡一张账单），
   * 而一条 `customer.subscription.*` 事件只解析得出**一家**门店。
   *
   * 不广播的话：老板退订之后只有锚点店变成 canceled，第二家店永远停在
   * active —— 写入闸门（bus.ts）和 AI 准入（billing/aiAdmission.ts）都是
   * 按 location 读自己那一行的，于是那家店退订之后继续开单、继续烧 AI 额度。
   * 这是直接的收入泄漏，而且账面上完全看不出来。
   *
   * 范围限定在**同一个 org**：跨 org 共用一个 Stripe 对象是 AUD-02 描述的
   * 串账，sql/0080 的触发器已经在数据库层禁掉了，这里不需要也不应该兜底。
   */
  const siblingIds = new Set<string>(itemByLocation.keys());
  siblingIds.delete(ctx.locationId);

  const siblings = subscriptionId || siblingIds.size > 0
    ? await tx<AccountRow[]>`
        select * from billing_accounts
        where org_id = ${ctx.orgId}
          and location_id <> ${ctx.locationId}
          and (
            (${subscriptionId}::text is not null
              and stripe_subscription_id = ${subscriptionId})
            or location_id = any(${[...siblingIds]}::uuid[])
          )
        -- ⚠️ 排序不是为了好看，是为了**固定加锁顺序**。同一条订阅上
        -- 两条事件并发到达时（例如续费与改档），锚点行先锁、兄弟行按
        -- location_id 依次锁 —— 顺序不固定的话两个事务会互相等对方那一行。
        order by location_id
        for update`
    : [];

  let skippedLicenseRows = anchorResult.skipped ? 1 : 0;
  for (const row of siblings) {
    const res = await applySubscriptionToRow(tx, row, patchFor(row), {
      isAnchor: false,
      namedInItems: itemByLocation.has(row.location_id),
    });
    if (res.skipped) skippedLicenseRows += 1;
  }

  audit({
    entityType: 'billing_account', entityId: acct.id,
    before: { plan: acct.plan, status: acct.subscription_status },
    after: {
      plan: anchorPatch.plan, status,
      hasCustomer: Boolean(customerId),
      hasSubscription: Boolean(subscriptionId),
      sourceEventId: input.sourceEventId ?? null,
      // 续期清零要留痕：「我的额度怎么突然满了」是要能查的
      includedReset: renewed,
      // 试用起止也留痕：「我什么时候被扣的第一笔钱」是客服第一个被问到的问题
      trialEndsAt,
      cancelAtPeriodEnd,
      // 一条事件同步了几家店。多店老板的账单纠纷第一句就是「哪几家店受影响」
      siblingsSynced: siblings.length,
      // 有几家店因为已经改用订阅码而被跳过（迁移 0120）。留痕是必须的：
      // 「为什么这家店没跟着退订」必须能在审计里一眼看到
      skippedLicenseRows,
    },
  });

  return {
    accountId: acct.id,
    plan: anchorPatch.plan,
    subscriptionStatus: status,
    includedReset: renewed,
    siblingsSynced: siblings.length,
  };
});

// ───────────────────────────────────────────────────────────────── 支付方式

registerHandler(SavePaymentMethod, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof SavePaymentMethod.input._type>) => {
  const acct = await ensureAccount(tx, ctx, { forUpdate: true });

  // 换了新卡就把两种额度的失败计数都清零 —— 换卡这个动作就是在说
  // 「这次能扣了」，还揣着旧卡的失败次数不放他会以为换了也没用
  const changed = input.paymentMethodId !== acct.default_payment_method_id;
  const reset = changed && Boolean(input.paymentMethodId);
  const label = input.paymentMethodId ? (input.label ?? null) : null;

  await tx`
    update billing_accounts set
      default_payment_method_id = ${input.paymentMethodId},
      payment_method_label = ${label},
      auto_topup_credits_failures = ${reset ? 0 : acct.auto_topup_credits_failures},
      auto_topup_minutes_failures = ${reset ? 0 : acct.auto_topup_minutes_failures}
    where id = ${acct.id}`;

  // ⚠️ 审计里只留「换了一张卡，显示成什么」。payment_method id 也不记 ——
  // 它不是卡号，但它是能对着 Stripe 发起扣款的东西
  audit({
    entityType: 'billing_account', entityId: acct.id,
    before: { hadPaymentMethod: Boolean(acct.default_payment_method_id) },
    after: { hasPaymentMethod: Boolean(input.paymentMethodId), label },
  });

  return { hasPaymentMethod: Boolean(input.paymentMethodId), label };
});

// ─────────────────────────────────────────────────────────────────── 充值

registerHandler(RecordTopup, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof RecordTopup.input._type>) => {
  const acct = await ensureAccount(tx, ctx, { forUpdate: true });
  const unit = input.unit as QuotaUnit;

  /**
   * 第二道去重：同一个 PaymentIntent 只入账一次。
   *
   * 命令总线的幂等键（PaymentIntent id）已经挡住了绝大多数重复，
   * 但**两条路都会来记这一笔**：扣款成功后路由记一次，Stripe 的
   * `payment_intent.succeeded` webhook 也会来记一次。两条路各自生成
   * 幂等键，挡不住对方 —— 而重复入账的方向是我们白送客户一笔额度。
   */
  if (input.stripePaymentIntentId) {
    const [dupe] = await tx<{ id: string; balance_after: number }[]>`
      select id, balance_after from credit_ledger
      where location_id = ${ctx.locationId}
        and stripe_payment_intent_id = ${input.stripePaymentIntentId}
        and kind = 'topup'
      limit 1`;
    if (dupe) {
      audit({
        entityType: 'credit_ledger', entityId: dupe.id,
        after: { alreadyRecorded: true, stripePaymentIntentId: input.stripePaymentIntentId },
      });
      return {
        ledgerId: dupe.id, unit: input.unit,
        balanceAfter: dupe.balance_after, alreadyRecorded: true,
      };
    }
  }

  const { ledgerId, balanceAfter } = await appendLedger(tx, ctx, acct, {
    kind: 'topup',
    unit,
    amount: input.units,
    paidCents: input.paidCents,
    source: 'stripe',
    stripePaymentIntentId: input.stripePaymentIntentId,
  });

  // 充上了就把这一种额度的失败计数清零：这张卡现在是好的
  const c = COLS[unit];
  await tx`
    update billing_accounts set
      ${tx(c.failures)} = 0,
      ${tx(c.lastAt)} = ${input.trigger === 'auto' ? tx`now()` : tx(c.lastAt)}
    where id = ${acct.id}`;

  audit({
    entityType: 'credit_ledger', entityId: ledgerId,
    after: {
      kind: 'topup', unit, units: input.units,
      paidCents: input.paidCents, trigger: input.trigger, balanceAfter,
    },
  });

  return { ledgerId, unit: input.unit, balanceAfter, alreadyRecorded: false };
});

// ──────────────────────────────────────────────────────── 自动续充：先占位

registerHandler(ClaimAutoTopup, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof ClaimAutoTopup.input._type>) => {
  const unit = input.unit as QuotaUnit;

  /**
   * ⭐ 先锁住这家店这一种额度的续充位，再判断。
   *
   * 不锁的话，两个并发请求会同时看到「余额低于阈值」，各自去 Stripe
   * 扣一笔 $50 —— 老板一分钟内被扣两次，而账本上是两条看起来都合法的记录。
   * advisory lock 只锁这一家店的这一种额度，别的店、另一种额度互不影响。
   */
  await tx`select pg_advisory_xact_lock(hashtext(${`topup:${ctx.locationId}:${unit}`}))`;

  const acct = await ensureAccount(tx, ctx, { forUpdate: true });
  const decision = shouldAutoTopup(unit, toAutoTopupState(acct, unit));

  if (!decision.charge) {
    // 不充也要留痕 —— 出账单纠纷时要能回答「那天为什么没自动充上」，
    // 而不是耸肩。每个分支都有名字（disabled / cooling_down / …）
    audit({
      entityType: 'billing_account', entityId: acct.id,
      after: { autoTopup: 'skipped', unit, reason: decision.reason },
    });
    return {
      charge: false, reason: decision.reason, unit: input.unit,
      units: null, priceCents: null,
      stripeCustomerId: null, paymentMethodId: null, idempotencyKey: null,
    };
  }

  /**
   * **当场占位。** 冷却窗口从这一刻开始算，第二个请求进来会被
   * `cooling_down` 挡掉 —— 哪怕 Stripe 那边这次还没扣完。
   *
   * 代价是：扣失败时这次冷却是白占的（十分钟内不再试）。
   * 这个代价是对的 —— 卡被拒的时候，最不该做的事就是马上再试一次。
   */
  await tx`update billing_accounts set ${tx(COLS[unit].lastAt)} = now() where id = ${acct.id}`;

  /**
   * 给 Stripe 的幂等键按**冷却窗口分桶**。
   * 我们这边重试风暴时复用同一个键 → Stripe 只会扣一次。
   * 用 UUID 的话每次重试都是 Stripe 眼里的一笔新扣款。
   */
  const bucket = Math.floor(Date.now() / TOPUP_COOLDOWN_MS);
  const idempotencyKey = `gf-topup-${unit}-${ctx.locationId}-${bucket}`;

  audit({
    entityType: 'billing_account', entityId: acct.id,
    after: {
      autoTopup: 'claimed', unit,
      units: decision.units, priceCents: decision.priceCents,
      balance: balanceOf(acct, unit),
    },
  });

  return {
    charge: true, reason: null, unit: input.unit,
    units: decision.units, priceCents: decision.priceCents,
    stripeCustomerId: acct.stripe_customer_id,
    paymentMethodId: acct.default_payment_method_id,
    idempotencyKey,
  };
});

registerHandler(RecordTopupFailure, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof RecordTopupFailure.input._type>) => {
  const acct = await ensureAccount(tx, ctx, { forUpdate: true });
  const unit = input.unit as QuotaUnit;
  const c = COLS[unit];
  const state = toAutoTopupState(acct, unit);

  const failures = state.failures + 1;
  const disabled = failures >= MAX_TOPUP_FAILURES;

  /**
   * 连续失败到上限就**自动关掉**这一种额度的自动续充。
   *
   * 银行看到一张卡连续被拒会直接把它冻了 —— 那时候我们不只是没收到钱，
   * 是把客户的卡搞停了，而他要打电话给银行才能解开。
   */
  await tx`
    update billing_accounts set
      ${tx(c.failures)} = ${failures},
      ${tx(c.enabled)} = ${disabled ? false : state.enabled}
    where id = ${acct.id}`;

  audit({
    entityType: 'billing_account', entityId: acct.id,
    after: { autoTopup: 'failed', unit, reason: input.reason, failures, disabled },
  });

  return { unit: input.unit, failures, disabled };
});

/**
 * Stripe is the only writer of paid subscription / credit state.
 * These two commands stay registered for API compatibility, but they
 * must not activate a plan, grant units, or insert a paid invoice.
 * Owners change plan or buy packs through Checkout / Customer Portal;
 * webhooks then call `billing.syncSubscription` / `billing.recordTopup`.
 */
function refuseLocalPaidMutation(command: 'billing.changePlan' | 'billing.buyAddon'): never {
  throw new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE, {
    details: { service: 'stripe', reason: 'use_checkout_or_portal', command },
  });
}

registerHandler(BillingChangePlan, async () => {
  refuseLocalPaidMutation('billing.changePlan');
});

registerHandler(BillingBuyAddon, async () => {
  refuseLocalPaidMutation('billing.buyAddon');
});

registerHandler(BillingSaveTaxProfile, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof BillingSaveTaxProfile.input._type>) => {
  const acct = await ensureAccount(tx, ctx, { forUpdate: true });

  const taxProfile = {
    legalEntityName: input.legalEntityName,
    taxId: input.taxId,
    billingEmail: input.billingEmail,
  };

  await tx`
    update billing_accounts set
      tax_profile = ${JSON.stringify(taxProfile)}::jsonb
    where id = ${acct.id}`;

  audit({
    entityType: 'billing_account',
    entityId: acct.id,
    after: { taxProfile },
  });

  return { saved: true };
});

// ─────────────────────────────────────────────────────────────────── 发票

/**
 * 把一张 Stripe 发票落库。
 *
 * ⚠️ 幂等靠 `stripe_invoice_id` 的部分唯一索引（sql/0085）：
 * `invoice.paid` 同样是「至少一次」投递，不去重的话老板的发票列表里
 * 会出现两张一模一样的单据，而他会以为自己被扣了两次。
 */
registerHandler(RecordInvoice, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof RecordInvoice.input._type>) => {
  const [existing] = await tx<{ id: string }[]>`
    select id from billing_invoices
    where stripe_invoice_id = ${input.stripeInvoiceId} limit 1`;

  if (existing) {
    // 状态可能从 pending 变成 paid（先开票后付款），所以要更新而不是直接返回
    await tx`
      update billing_invoices set
        status = ${input.status},
        amount_cents = ${input.amountCents},
        hosted_invoice_url = ${input.hostedInvoiceUrl ?? null},
        receipt_pdf_url = ${input.receiptPdfUrl ?? null}
      where id = ${existing.id}`;
    audit({
      entityType: 'billing_invoice', entityId: existing.id,
      after: { stripeInvoiceId: input.stripeInvoiceId, status: input.status, updated: true },
    });
    return { invoiceId: existing.id, alreadyRecorded: true };
  }

  const [row] = await tx<{ id: string }[]>`
    insert into billing_invoices
      (org_id, location_id, invoice_number, period, description, amount_cents,
       status, date, receipt_pdf_url, stripe_invoice_id, hosted_invoice_url)
    values (${ctx.orgId}, ${ctx.locationId}, ${input.invoiceNumber}, ${input.period},
            ${input.description}, ${input.amountCents}, ${input.status}, ${input.date},
            ${input.receiptPdfUrl ?? null}, ${input.stripeInvoiceId},
            ${input.hostedInvoiceUrl ?? null})
    on conflict (stripe_invoice_id) where stripe_invoice_id is not null do nothing
    returning id`;

  // 并发插入被 on conflict 挡住时 returning 是空的 —— 那说明另一条路已经写了
  if (!row) {
    const [now] = await tx<{ id: string }[]>`
      select id from billing_invoices
      where stripe_invoice_id = ${input.stripeInvoiceId} limit 1`;
    return { invoiceId: now!.id, alreadyRecorded: true };
  }

  audit({
    entityType: 'billing_invoice', entityId: row.id,
    after: {
      stripeInvoiceId: input.stripeInvoiceId, status: input.status,
      amountCents: input.amountCents, period: input.period,
    },
  });

  return { invoiceId: row.id, alreadyRecorded: false };
});

// ───────────────────────────────────────────────────────── 充值冲销（退款/拒付）

/**
 * 一笔充值被退款或拒付：**写一条反向流水**。
 *
 * ⭐ 不改原来那一行 —— 账本只追加（sql/0018 的 `ledger_append_only` 触发器
 * 连 update 都不给）。「为什么少了 1000 积分」这个问题必须能从流水上
 * 一眼看出来。
 *
 * ⚠️ 余额允许被冲成负数。客户拿走了额度又把钱要了回去，那个负数就是
 * 事实本身；抹平它等于替他把账做平。
 */
registerHandler(RecordTopupReversal, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof RecordTopupReversal.input._type>) => {
  const acct = await ensureAccount(tx, ctx, { forUpdate: true });

  // 原始那一笔。找不到 = 这笔钱从来没在我们这边入过账（例如订阅月费的
  // 退款），什么都不做 —— 凭空扣一笔额度比不扣更糟
  const [origin] = await tx<{ unit: string; amount: number }[]>`
    select unit, amount from credit_ledger
    where location_id = ${ctx.locationId}
      and stripe_payment_intent_id = ${input.stripePaymentIntentId}
      and kind = 'topup'
    limit 1`;

  if (!origin) {
    audit({
      entityType: 'billing_account', entityId: acct.id,
      after: {
        reversal: 'skipped', reason: 'no_matching_topup',
        stripePaymentIntentId: input.stripePaymentIntentId,
      },
    });
    return { reversed: false, unit: null, units: null, balanceAfter: null };
  }

  // 已经冲过了。退款和拒付可能先后各来一条事件，第二条不该再扣一次
  const [dupe] = await tx<{ id: string }[]>`
    select id from credit_ledger
    where location_id = ${ctx.locationId}
      and stripe_payment_intent_id = ${input.stripePaymentIntentId}
      and kind = 'reversal'
    limit 1`;

  if (dupe) {
    // ⚠️ 这一支也要留痕：命令总线要求每条命令至少登记一条审计（宪法第 1 条），
    // 而「为什么第二次拒付没有再扣额度」本来就是客服要答的问题
    audit({
      entityType: 'credit_ledger', entityId: dupe.id,
      after: {
        reversal: 'already_reversed', reason: input.reason,
        stripePaymentIntentId: input.stripePaymentIntentId,
      },
    });
    return {
      reversed: false, unit: origin.unit as QuotaUnit,
      units: null, balanceAfter: balanceOf(acct, origin.unit as QuotaUnit),
    };
  }

  const unit = origin.unit as QuotaUnit;
  const { balanceAfter } = await appendLedger(tx, ctx, acct, {
    kind: 'reversal',
    unit,
    amount: -origin.amount,
    source: 'stripe',
    stripePaymentIntentId: input.stripePaymentIntentId,
    // 冲销必须写原因（applyEntry 会挡住没写原因的那一条）
    reason: input.reason === 'dispute' ? '拒付冲销（chargeback）' : '退款冲销',
  });

  audit({
    entityType: 'billing_account', entityId: acct.id,
    after: {
      reversal: input.reason, unit, units: origin.amount, balanceAfter,
      stripePaymentIntentId: input.stripePaymentIntentId,
    },
  });

  return { reversed: true, unit, units: origin.amount, balanceAfter };
});

export { unitsPerTopup, TOPUP_PRICE_CENTS };

registerHandler(ConfirmOwnershipPayment, async ({ ctx, tx, audit }) => {
  const [row] = await tx<{ settings: Record<string, unknown> }[]>`select settings from locations where id=${ctx.locationId} for update`;
  if (!row) throw new AppError(ERROR_CODES.NOT_FOUND);
  const before = row.settings.ownership_payment_review as { newOwnerUserId?: string } | undefined;
  if (before && before.newOwnerUserId !== ctx.userId) throw new AppError(ERROR_CODES.PERMISSION_DENIED);
  await tx`update locations set settings=jsonb_set(settings,'{ownership_payment_review,required}','false'::jsonb,false) where id=${ctx.locationId}`;
  audit({ entityType: 'location', entityId: ctx.locationId, before: { ownershipPaymentReview: before }, after: { ownershipPaymentReview: false } });
  return { confirmed: true };
});
