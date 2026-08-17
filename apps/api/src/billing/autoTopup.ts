/**
 * 自动续充（Auto-Reload）的触发点。
 *
 * ## ⭐ 为什么不放在扣费那个事务里
 *
 * 扣费是数据库事务里的一次 update；调 Stripe 是几百毫秒到几秒的外部 IO。
 * 塞进同一个事务的后果有两层：
 *   · 连接和快照被占住那么久，几家店同时用 AI 就能把连接池吃干净
 *   · 更糟的是**事务回滚不了 Stripe 那边的扣款** —— 钱扣了、账没记，
 *     而客户会看到一笔他账本上找不到的 $50
 *
 * 所以顺序是：扣费事务**提交之后**，再单独跑这一趟。
 *
 * ## 三步，每一步都可以单独失败
 *
 *   1. `billing.claimAutoTopup` —— 事务内拿锁、判断、**当场占位**
 *   2. Stripe 扣款（事务外）
 *   3. `billing.recordTopup` / `billing.recordTopupFailure`
 *
 * 第 1 步先占位是关键：占位之后冷却窗口就开始算，第二个并发请求
 * 会被 `cooling_down` 挡掉。反过来（先扣钱再占位）会让老板一分钟内
 * 被扣两次 $50，而账本上是两条看起来都合法的记录。
 *
 * ## 谁来调它
 *
 * **不做跨租户的定时扫描。** 那需要一个能看到所有店的连接，
 * 而 `apps/*` 拿不到那种凭据（宪法第 5 条，CI 会失败）。
 * 好在余额只会因为用量而下降，所以在用量发生之后顺手看一眼就够了：
 *   · 拍照开店提取完（`/v1/blueprint/:id/extract`）
 *   · 副驾回答完（`/v1/ai/copilot`）
 *   · 电话挂断记完账（Telnyx webhook）
 *   · 老板打开「订阅与余额」那一屏
 *
 * ⚠️ **它永远不该让调用方失败。** 前台点「拍价目表」，结果因为
 * 一张过期的卡而看到一个错误页 —— 那是把计费的问题变成了业务的问题。
 * 所以整段包在 try 里，出错只记日志。
 */

import type { CommandContext } from '@gf/contracts';
import type { QuotaUnit } from '@gf/payroll';
import { dispatch } from '../bus';
import { stripeClient, stripeConfigured, declineReason } from '../stripe/client';

interface Logger {
  info: (o: unknown, m: string) => void;
  warn: (o: unknown, m: string) => void;
}

export interface AutoTopupOutcome {
  unit: QuotaUnit;
  /** 有没有真的扣一笔 */
  charged: boolean;
  units?: number;
  priceCents?: number;
  balanceAfter?: number;
  /** 没扣的原因（disabled / included_remaining / cooling_down / …）或失败码 */
  reason?: string;
}

interface ClaimResult {
  charge: boolean;
  reason: string | null;
  unit: QuotaUnit;
  units: number | null;
  priceCents: number | null;
  stripeCustomerId: string | null;
  paymentMethodId: string | null;
  idempotencyKey: string | null;
}

export async function maybeAutoTopup(
  ctx: CommandContext,
  unit: QuotaUnit,
  log: Logger,
): Promise<AutoTopupOutcome> {
  // 没配 Stripe 就整条跳过。开发环境天天在这条路上跑，
  // 不该每次都往日志里刷一条报错
  if (!stripeConfigured()) return { unit, charged: false, reason: 'stripe_not_configured' };

  try {
    // ── 1. 认领（事务内：拿锁 → 判断 → 占位）─────────────────────────────
    const claim = await dispatch<ClaimResult>('billing.claimAutoTopup', { unit }, ctx);
    if (!claim.result.charge) {
      return { unit, charged: false, reason: claim.result.reason ?? 'skipped' };
    }

    const { units, priceCents, stripeCustomerId, paymentMethodId, idempotencyKey } = claim.result;
    if (!units || !priceCents || !stripeCustomerId || !paymentMethodId) {
      // 纯函数已经挡过 no_payment_method，走到这里说明账户上有卡但没有
      // Stripe 客户 —— 数据不一致，记一次失败让它进冷却，别反复试
      await recordFailure(ctx, unit, 'missing_stripe_customer', log);
      return { unit, charged: false, reason: 'missing_stripe_customer' };
    }

    // ── 2. 扣款（事务外）─────────────────────────────────────────────────
    //
    // `off_session: true` = 老板不在浏览器前面。卡如果要求 3DS 验证，
    // Stripe 会直接拒并给 `authentication_required` —— 那正是我们要的：
    // 半夜跳一个验证弹窗给没人看的屏幕毫无意义，不如失败并通知他。
    const stripe = stripeClient();
    let paymentIntentId: string;
    try {
      const pi = await stripe.paymentIntents.create({
        amount: priceCents,
        currency: 'usd',
        customer: stripeCustomerId,
        payment_method: paymentMethodId,
        off_session: true,
        confirm: true,
        description: unit === 'credit'
          ? 'GenieFront AI 积分自动续充' : 'GenieFront AI 语音分钟自动续充',
        metadata: {
          gf_location_id: ctx.locationId,
          gf_org_id: ctx.orgId,
          gf_kind: 'auto_topup',
          // ⚠️ 单位必须写进 metadata：webhook 那条路只拿得到这个对象，
          // 没有它就不知道该给哪一种额度入账（给错了是实打实的乱账）
          gf_unit: unit,
          gf_units: String(units),
        },
      }, idempotencyKey ? { idempotencyKey } : undefined);
      paymentIntentId = pi.id;

      // requires_action / processing 都**不算成功**。记成成功的话
      // 客户余额加了而钱可能永远到不了 —— 等 webhook 来确认
      if (pi.status !== 'succeeded') {
        log.info({ locationId: ctx.locationId, unit, status: pi.status },
                 'auto topup pending, waiting for webhook');
        return { unit, charged: false, reason: `pending_${pi.status}` };
      }
    } catch (e) {
      const reason = declineReason(e);
      log.warn({ err: e, locationId: ctx.locationId, unit, reason }, 'auto topup declined');
      await recordFailure(ctx, unit, reason, log);
      return { unit, charged: false, reason };
    }

    // ── 3. 入账 ──────────────────────────────────────────────────────────
    //
    // 幂等键用 PaymentIntent id：这一步失败重试、以及随后到达的
    // `payment_intent.succeeded` webhook，都会落到同一条账本记录上
    const rec = await dispatch<{ balanceAfter: number; alreadyRecorded: boolean }>(
      'billing.recordTopup',
      {
        unit, units, paidCents: priceCents,
        stripePaymentIntentId: paymentIntentId, trigger: 'auto',
      },
      ctx,
      { idempotencyKey: `topup-${paymentIntentId}` },
    );

    log.info({
      locationId: ctx.locationId, unit, units, priceCents,
      balanceAfter: rec.result.balanceAfter,
    }, 'auto topup charged');

    return { unit, charged: true, units, priceCents, balanceAfter: rec.result.balanceAfter };
  } catch (e) {
    // ⚠️ 绝不往上抛。前台点「拍价目表」不该因为一张过期的卡而看到错误页
    log.warn({ err: e, locationId: ctx.locationId, unit }, 'auto topup failed');
    return { unit, charged: false, reason: 'error' };
  }
}

async function recordFailure(
  ctx: CommandContext, unit: QuotaUnit, reason: string, log: Logger,
): Promise<void> {
  try {
    await dispatch('billing.recordTopupFailure', { unit, reason }, ctx);
  } catch (e) {
    log.warn({ err: e, locationId: ctx.locationId, unit }, 'failed to record topup failure');
  }
}

/**
 * 给系统 actor（Telnyx webhook）用的续充上下文。
 *
 * 电话那条路上的 actor 只有四条窄权限（telnyx/routes.ts 的
 * `PHONE_AI_PERMISSIONS`），**里面没有 `billing.manage`** —— 这是对的：
 * 一个靠签名进来的入口不该有扣客户钱的权限。
 *
 * 所以续充在那条路上要换一个上下文：**权限只加 `billing.manage` 这一条**，
 * `actorKind` 保持 `system`，审计里看得出这是机器自己触发的续充，
 * 而不是某个前台点的。
 */
export function billingSystemContext(ctx: CommandContext): CommandContext {
  return {
    ...ctx,
    membershipId: null,
    actorKind: 'system',
    permissions: new Set(['billing.manage'] as const),
  };
}
