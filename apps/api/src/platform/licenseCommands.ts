/**
 * 运营台的订阅码动作（sql/0120，计划批 2 / 批 6）
 *
 * ## 审计记在哪
 *
 * 有门店的动作（挂上额度、改期、收回）走 `writePlatformAudit` ——
 * 和其他运营动作同一张 `audit_log`。
 *
 * **签发与撤销没有门店**（一张未定向的码在签发那一刻不属于任何租户，
 * 而 `audit_log.org_id` 是 not null 且有 tenant_isolation）。那两件事的
 * 记录就是 `license_codes` 那一行本身：谁签的（`issued_by_operator_id`）、
 * 什么时候、收了多少钱（`payment_note` / `amount_cents`）、谁撤的、为什么。
 * 它比一条审计行更好查 —— 运营台的列表页直接就是它。
 *
 * ## 明文码只出现一次
 *
 * 签发接口的响应体是**唯一**能看到明文的地方。它不落库、不进日志、
 * 不进审计。运营要重发给店家只能重新签一张（并撤掉旧的）——
 * 这正是我们想要的：一张码泄露之后能被追到是哪一次签发。
 */

import { z } from 'zod';
import {
  AppError, ERROR_CODES,
  PlatformIssueLicenseInput,
  PlatformRevokeLicenseInput,
  PlatformApplyLicenseInput,
  PlatformUpdateLicensePeriodInput,
  PlatformRevokeStoreLicenseInput,
} from '@gf/contracts';
import { withTenant, licenseIssue, licenseRevoke } from '@gf/db';
import type { Plan, QuotaUnit } from '@gf/payroll';
import {
  applyLicense, claimLicense, redeemClaimedLicense,
  generateLicenseCode, hashLicenseCode, licenseCodePrefix,
  type LicenseTerms, type LicenseEffect,
} from '../handlers/license';
import { stripeClient } from '../stripe/client';
import type { PlatformOperator } from './auth';
import { mapPlatformReadError } from './auth';
import { writePlatformAudit } from './audit';

function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: { issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })) },
    });
  }
  return parsed.data;
}

/**
 * 各 kind 必须带齐自己那几个字段。
 *
 * DB 那边有 `license_terms_complete` 兜底，但错误信息是一句 check 约束名 ——
 * 运营在界面上看到那句话不知道该改哪个框。这里挡一次是为了给人看的。
 */
function assertTermsComplete(input: {
  kind: string; plan?: string | undefined; durationDays?: number | undefined;
  unit?: string | undefined; amount?: number | undefined;
}): void {
  const need = input.kind === 'quota_pack'
    ? (input.unit !== undefined && input.amount !== undefined)
    : (input.plan !== undefined && input.durationDays !== undefined);
  if (!need) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: {
        reason: 'license_terms_incomplete',
        kind: input.kind,
        need: input.kind === 'quota_pack' ? ['unit', 'amount'] : ['plan', 'durationDays'],
      },
    });
  }
}

const isoInDays = (days: number, now = new Date()): string =>
  new Date(now.getTime() + days * 86_400_000).toISOString();

/**
 * 把数据库那一侧的身份拒绝翻译成 403。
 *
 * `gf_license_issue` / `gf_license_revoke` 用 `errcode = 42501` 表达
 * 「你不是 super_admin」。不翻译的话运营台上看到的是一个 500 ——
 * 而 500 的意思是「我们坏了」，会让人去查日志找一个根本不存在的故障
 * （判定本身是对的：签发付费服务这件事 support 不该能做）。
 */
async function mapOperatorRefusal<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const msg = (e as { message?: string }).message ?? '';
    if ((e as { code?: string }).code === '42501' && /super_admin/.test(msg)) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, {
        details: { reason: 'requires_super_admin' },
      });
    }
    /*
     * 22023 是那几个窄口函数表达「入参不对」的方式：
     * `license_not_found` / `license_already_redeemed` / `revoke_reason_required`…
     * 不翻译的话运营台看到 500，而这些全是**他可以自己改**的东西。
     */
    if ((e as { code?: string }).code === '22023') {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
        details: { reason: /^[a-z_]+$/.test(msg) ? msg : 'invalid_request' },
      });
    }
    return mapPlatformReadError(e);
  }
}

export interface IssuedLicense {
  codeId: string;
  /** ⭐ 明文。**只在这一次响应里出现**，之后任何地方都取不回来 */
  code: string;
  codePrefix: string;
  kind: string;
  validUntil: string;
}

/** 签发一张码。限 `super_admin`（判定在 `gf_license_issue` 里） */
export async function issueLicense(
  operator: PlatformOperator,
  raw: unknown,
): Promise<IssuedLicense> {
  const input = parse(PlatformIssueLicenseInput, raw);
  assertTermsComplete(input);

  const code = generateLicenseCode();
  // ⚠️ `?? ` 兜底而不是直接用 zod 的 default：`parse<T>` 那个泛型 helper
  // 在 exactOptionalPropertyTypes 下把带默认值的字段推成可选，
  // 类型上拿不到 default 的保证（同 commands.ts 的那个 helper）
  const validUntil = isoInDays(input.validForDays ?? 90);

  const codeId = await mapOperatorRefusal(() => licenseIssue(operator.userId, {
    kind: input.kind,
    codeHash: hashLicenseCode(code),
    codePrefix: licenseCodePrefix(code),
    paymentNote: input.paymentNote,
    validUntil,
    plan: input.plan ?? null,
    durationDays: input.durationDays ?? null,
    unit: input.unit ?? null,
    amount: input.amount ?? null,
    amountCents: input.amountCents ?? null,
    targetLocationId: input.targetLocationId ?? null,
    maxRedemptions: input.maxRedemptions ?? 1,
  }));

  return {
    codeId, code, codePrefix: licenseCodePrefix(code), kind: input.kind, validUntil,
  };
}

/** 撤销一张**还没被兑换过**的码。已生效的码不撤 —— 那是历史事实 */
export async function revokeLicense(
  operator: PlatformOperator,
  raw: unknown,
): Promise<{ codeId: string; status: string; already: boolean }> {
  const input = parse(PlatformRevokeLicenseInput, raw);
  return mapOperatorRefusal(
    () => licenseRevoke(operator.userId, input.codeId, input.reason));
}

/**
 * 直接给一家店挂上额度：**定向签发 + 立即兑换**，一个事务。
 *
 * ⭐ 走的仍然是「签发 → 兑换 → applyLicense」那一条路，不另开写入口。
 * 顺带的好处是运营代兑和店主自助兑换在 `license_redemptions` 里长得一样，
 * 对账时不用区分两种来源。
 */
export async function applyLicenseToStore(
  operator: PlatformOperator,
  orgId: string,
  locationId: string,
  raw: unknown,
  ip?: string,
): Promise<{ codeId: string; effect: LicenseEffect }> {
  const input = parse(PlatformApplyLicenseInput, raw);
  assertTermsComplete(input);

  const code = generateLicenseCode();
  const tenant = { orgId, locationId, membershipId: null, userId: operator.userId };

  return withTenant(tenant, async (tx) => {
    const [issued] = await tx<{ id: string }[]>`
      select gf_license_issue(
        ${input.kind}, ${hashLicenseCode(code)}, ${licenseCodePrefix(code)},
        ${input.paymentNote}, ${isoInDays(1)}::timestamptz,
        ${input.plan ?? null}, ${input.durationDays ?? null},
        ${input.unit ?? null}, ${input.amount ?? null}, ${input.amountCents ?? null},
        ${orgId}, ${locationId}, 1) as id`;
    if (!issued) throw new Error('gf_license_issue 没有返回行');

    const claim = await claimLicense(tx, code);
    const effect = await redeemClaimedLicense(tx, { orgId, locationId }, claim, {
      reason: `license:${claim.codePrefix} ${input.paymentNote}`,
    });

    await writePlatformAudit(tx, operator, {
      orgId,
      locationId,
      command: 'platform.applyLicense',
      entityType: 'billing_account',
      entityId: locationId,
      before: effect.before,
      after: {
        ...effect.after,
        kind: input.kind,
        codeId: claim.codeId,
        codePrefix: claim.codePrefix,
        paymentNote: input.paymentNote,
        amountCents: input.amountCents ?? null,
        unit: effect.unit ?? null,
        amount: effect.amount ?? null,
        invoiceId: effect.invoiceId,
      },
      ...(ip === undefined ? {} : { ip }),
    });

    return { codeId: claim.codeId, effect };
  });
}

/**
 * 改有效期。`note` 必填 —— 改到期日是直接改「这家店能用到哪天」，
 * 没有原因的改动和一次误操作长得一模一样。
 */
export async function updateStoreLicensePeriod(
  operator: PlatformOperator,
  orgId: string,
  locationId: string,
  raw: unknown,
  ip?: string,
): Promise<LicenseEffect> {
  const input = parse(PlatformUpdateLicensePeriodInput, raw);
  const terms: LicenseTerms = input.periodEnd !== undefined
    ? { kind: 'period_set', periodEnd: new Date(input.periodEnd) }
    : { kind: 'period_extend', days: input.extendDays! };

  const tenant = { orgId, locationId, membershipId: null, userId: operator.userId };
  return withTenant(tenant, async (tx) => {
    const effect = await applyLicense(tx, { orgId, locationId }, terms, {
      reason: input.note,
    });
    await writePlatformAudit(tx, operator, {
      orgId,
      locationId,
      command: 'platform.updateLicensePeriod',
      entityType: 'billing_account',
      entityId: locationId,
      before: effect.before,
      after: { ...effect.after, note: input.note, change: terms.kind },
      ...(ip === undefined ? {} : { ip }),
    });
    return effect;
  });
}

/**
 * 立刻收回一家店的订阅码额度：当场到期，冻结写入、读照常。
 *
 * ⚠️ **不动兑换历史。** 那些行记的是「我们确实收过这笔钱」，
 * 而收回的原因（退款、纠纷、发错了）是另一件事，写在审计里。
 */
export async function revokeStoreLicense(
  operator: PlatformOperator,
  orgId: string,
  locationId: string,
  raw: unknown,
  ip?: string,
): Promise<LicenseEffect> {
  const input = parse(PlatformRevokeStoreLicenseInput, raw);
  const tenant = { orgId, locationId, membershipId: null, userId: operator.userId };
  return withTenant(tenant, async (tx) => {
    const effect = await applyLicense(tx, { orgId, locationId }, { kind: 'period_revoke' }, {
      reason: input.reason,
    });
    await writePlatformAudit(tx, operator, {
      orgId,
      locationId,
      command: 'platform.revokeStoreLicense',
      entityType: 'billing_account',
      entityId: locationId,
      before: effect.before,
      after: { ...effect.after, reason: input.reason },
      ...(ip === undefined ? {} : { ip }),
    });
    return effect;
  });
}

/** 类型收窄给路由用：契约里是 string 枚举，`applyLicense` 要的是这两个类型 */
export type { Plan, QuotaUnit };


/**
 * Stripe → 订阅码：**先在 Stripe 那边停掉这家店的收费，再挂订阅码。**
 *
 * ## ⭐ 删的是这家店的 item，不是整条订阅
 *
 * 多店经营共用**同一条订阅**，一家店一个 item（sql/0080、
 * `/v1/billing/add-store`）。直接 `subscriptions.cancel` 会把老板另外两家店
 * 一起停掉 —— 而那两家店没有任何人动过，第二天早上一起冻结。
 *
 * 只有当这家店是那条订阅上**最后一个** item 时才取消订阅本身
 *（Stripe 也不允许删掉订阅的最后一个 item）。
 *
 * ## 顺序不能反，而且两步不在一个事务里
 *
 * Stripe 那一步是外部 IO，塞进数据库事务会占住连接几秒（同
 * `billing.ts` 契约文件头的判断）。所以：**先停 Stripe，成功了再写库**。
 * 反过来的话，写库成功而 Stripe 停不掉 = 客户既在用订阅码又在被按月扣款。
 * 现在这个顺序下最坏的结果是「Stripe 停了但库没写成」——
 * 那家店掉回 `canceled`（只读），运营重试一次就好，钱没有多扣。
 *
 * ## 已付未用的那部分不折现
 *
 * 退款由人在 Stripe 后台操作，`paymentNote` 里写清楚。系统里按比例算退款
 * 是另一个量级的复杂度，而且算出来的数和 Stripe 的必然对不上。
 */
export async function switchStoreToLicense(
  operator: PlatformOperator,
  orgId: string,
  locationId: string,
  raw: unknown,
  ip?: string,
): Promise<{ codeId: string; stripeAction: string; effect: LicenseEffect }> {
  const input = parse(PlatformApplyLicenseInput, raw);
  if (input.kind !== 'subscription') {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: { reason: 'switch_requires_subscription_kind' },
    });
  }
  assertTermsComplete(input);

  const tenant = { orgId, locationId, membershipId: null, userId: operator.userId };
  const [acct] = await withTenant(tenant, (tx) => tx<{
    sub: string | null; item: string | null; source: string; status: string;
  }[]>`
    select stripe_subscription_id as sub, stripe_subscription_item_id as item,
           billing_source as source, subscription_status as status
    from billing_accounts where location_id = ${locationId}`);
  if (!acct) {
    throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'billing_account' } });
  }

  /*
   * Stripe 那一步做什么，只看**现在还挂着什么**，不看 status。
   * 一条 `past_due` 的订阅照样在按月重试扣款，不删 item 就还会扣。
   */
  let stripeAction = 'none';
  if (acct.source === 'stripe' && acct.sub) {
    try {
      const sub = await stripeClient().subscriptions.retrieve(acct.sub);
      const live = (sub.items?.data ?? []).length;
      const ours = acct.item ?? (live === 1 ? sub.items?.data?.[0]?.id : undefined);

      if (sub.status === 'canceled') {
        stripeAction = 'already_canceled';
      } else if (ours && live > 1) {
        await stripeClient().subscriptionItems.del(ours, { proration_behavior: 'none' });
        stripeAction = 'item_deleted';
      } else {
        await stripeClient().subscriptions.cancel(acct.sub);
        stripeAction = 'subscription_canceled';
      }
    } catch (e) {
      throw new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE, {
        details: { service: 'stripe', reason: 'detach_failed', message: String(e) },
      });
    }
  }

  const code = generateLicenseCode();
  return withTenant(tenant, async (tx) => {
    const [issued] = await tx<{ id: string }[]>`
      select gf_license_issue(
        'subscription', ${hashLicenseCode(code)}, ${licenseCodePrefix(code)},
        ${input.paymentNote}, ${isoInDays(1)}::timestamptz,
        ${input.plan ?? null}, ${input.durationDays ?? null},
        null, null, ${input.amountCents ?? null},
        ${orgId}, ${locationId}, 1) as id`;
    if (!issued) throw new Error('gf_license_issue 没有返回行');

    const claim = await claimLicense(tx, code);
    const effect = await redeemClaimedLicense(tx, { orgId, locationId }, claim, {
      reason: `switch:${claim.codePrefix} ${input.paymentNote}`,
      // Stripe 侧已经停了（或本来就没在收），这里才允许越过权威冲突检查
      detachedFromStripe: true,
    });

    await writePlatformAudit(tx, operator, {
      orgId,
      locationId,
      command: 'platform.switchToLicense',
      entityType: 'billing_account',
      entityId: locationId,
      before: { ...effect.before, stripeSubscriptionId: acct.sub, stripeItemId: acct.item },
      after: {
        ...effect.after,
        stripeAction,
        codeId: claim.codeId,
        codePrefix: claim.codePrefix,
        paymentNote: input.paymentNote,
        amountCents: input.amountCents ?? null,
        invoiceId: effect.invoiceId,
      },
      ...(ip === undefined ? {} : { ip }),
    });

    return { codeId: claim.codeId, stripeAction, effect };
  });
}
