/**
 * 运营直接开店 —— 门店的第三条出生路径（计划批 6）
 *
 * ## 三条路径的分工
 *
 *   1. `gf_provision_tenant()`  付款 → Stripe webhook → 建 org + 店（第一家）
 *   2. `setup.location.create`  已登录老板自助开第二家店（org 已存在）
 *   3. **本文件**                运营代开：钱走微信 / 支付宝 / 现金，
 *                               订阅由一张 `store_open` 码挂上
 *
 * ## ⭐ 复用 `gf_provision_tenant()`，不新写建店逻辑
 *
 * 那个函数里有一堆「不会报错、只会错着跑」的东西：业态 / 语言 / 时区
 * 认不出时的回退与留档、slug 的随机后缀、默认营业时间、
 * `settings.capacity` 的初值。抄第二遍就一定会有一天两边不一致，
 * 而不一致的那一半是老板第一天就会看到的东西。
 *
 * 代价是要给它一个 `checkout_session_id`（它的幂等键）。这里传的是
 * **由店名 + 老板邮箱算出来的稳定键**，于是运营手一抖点两下「开店」
 * 返回的是同一家店，而不是两家。
 *
 * ## 激活信仍然走 magic link
 *
 * 不为这条路径另造「激活码」—— `signup/activation.ts` 的文件头已经论证过：
 * 「成为一家门店的老板」和登录同一个量级，别自己发明凭证。
 */

import { createHash } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import { AppError, ERROR_CODES, PlatformCreateStoreInput } from '@gf/contracts';
import { withTenant, provisionTenant } from '@gf/db';
import { sendActivationOnce } from '../signup/webhook';
import {
  claimLicense, redeemClaimedLicense,
  generateLicenseCode, hashLicenseCode, licenseCodePrefix,
} from '../handlers/license';
import type { PlatformOperator } from './auth';
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
 * 出生幂等键。
 *
 * ⚠️ 不含运营 id 也不含时间：同一家店由两个运营各点一次「开店」，
 * 要的仍然是同一家店。含时间的话双击就是两家店，而清理两家半开的店
 * 比多问一句「是不是已经建过了」贵得多。
 */
function provisionKey(shopName: string, ownerEmail: string): string {
  const canon = `${shopName.trim().toLowerCase()}|${ownerEmail.trim().toLowerCase()}`;
  return `ops:${createHash('sha256').update(canon).digest('hex').slice(0, 48)}`;
}

export interface OperatorCreatedStore {
  orgId: string;
  locationId: string;
  /** true = 这个店名 + 邮箱之前就建过了（重复提交）。**没有再挂一次订阅** */
  already: boolean;
  licenseCodeId: string | null;
  periodEnd: string | null;
}

export async function createStoreByOperator(
  operator: PlatformOperator,
  raw: unknown,
  log: FastifyBaseLogger,
  ip?: string,
): Promise<OperatorCreatedStore> {
  const input = parse(PlatformCreateStoreInput, raw);
  if (operator.role !== 'super_admin') {
    throw new AppError(ERROR_CODES.PERMISSION_DENIED, {
      details: { reason: 'requires_super_admin', action: 'platform.createStore' },
    });
  }

  const tenant = await provisionTenant({
    checkoutSessionId: provisionKey(input.shopName, input.ownerEmail),
    shopName: input.shopName,
    ownerEmail: input.ownerEmail,
    businessType: input.businessType ?? 'nail',
    timezone: input.timezone ?? 'America/New_York',
    locale: input.locale ?? 'en',
    plan: input.plan,
    phone: input.phone ?? null,
    metadata: {
      origin: 'ops_license',
      operatorUserId: operator.userId,
      paymentNote: input.paymentNote,
      amountCents: input.amountCents ?? null,
      durationDays: input.durationDays,
    },
  });

  /*
   * ⭐ 重复提交时**什么都不再做**。
   *
   * 再挂一次订阅码的话，双击「开店」就是白送一倍天数 —— 而那笔天数
   * 事后没有任何办法区分「他确实付了两次」和「运营点了两下」。
   * 要续期请走 `/license` 那条路，那条路上有 `note` 必填。
   */
  if (tenant.already) {
    if (input.sendActivation !== false) {
      await sendActivationOnce(tenant, input.ownerEmail, log);
    }
    return {
      orgId: tenant.orgId,
      locationId: tenant.locationId,
      already: true,
      licenseCodeId: null,
      periodEnd: null,
    };
  }

  const code = generateLicenseCode();
  const ctx = { orgId: tenant.orgId, locationId: tenant.locationId };

  const applied = await withTenant(
    { ...ctx, membershipId: null, userId: operator.userId },
    async (tx) => {
      const [issued] = await tx<{ id: string }[]>`
        select gf_license_issue(
          'store_open', ${hashLicenseCode(code)}, ${licenseCodePrefix(code)},
          ${input.paymentNote},
          ${new Date(Date.now() + 86_400_000).toISOString()}::timestamptz,
          ${input.plan}, ${input.durationDays},
          null, null, ${input.amountCents ?? null},
          ${tenant.orgId}, ${tenant.locationId}, 1) as id`;
      if (!issued) throw new Error('gf_license_issue 没有返回行');

      const claim = await claimLicense(tx, code);
      const effect = await redeemClaimedLicense(tx, ctx, claim, {
        reason: `store_open:${claim.codePrefix} ${input.paymentNote}`,
      });
      if (input.baseVoiceMinutes !== undefined) {
        await tx`update billing_accounts set manual_voice_minutes=${input.baseVoiceMinutes} where location_id=${tenant.locationId}`;
      }

      await writePlatformAudit(tx, operator, {
        orgId: tenant.orgId,
        locationId: tenant.locationId,
        command: 'platform.createStore',
        entityType: 'location',
        entityId: tenant.locationId,
        after: {
          shopName: input.shopName,
          ownerEmail: input.ownerEmail,
          plan: input.plan,
          durationDays: input.durationDays,
          baseVoiceMinutes: input.baseVoiceMinutes ?? null,
          paymentNote: input.paymentNote,
          amountCents: input.amountCents ?? null,
          codeId: claim.codeId,
          periodEnd: effect.after.licensePeriodEnd,
          invoiceId: effect.invoiceId,
        },
        ...(ip === undefined ? {} : { ip }),
      });

      return { codeId: claim.codeId, periodEnd: effect.after.licensePeriodEnd };
    },
  );

  /*
   * ⚠️ 发信放在事务**之外**，而且失败只记日志（`sendActivationOnce`
   * 自己去重）。事务里发的话，回滚了信也收不回来；而为一封信发不出去
   * 就回滚一家已经建好、已经收过钱的门店是更糟的选择（docs/12 §3 A5）。
   */
  if (input.sendActivation !== false) {
    await sendActivationOnce(tenant, input.ownerEmail, log);
  }

  return {
    orgId: tenant.orgId,
    locationId: tenant.locationId,
    already: false,
    licenseCodeId: applied.codeId,
    periodEnd: applied.periodEnd,
  };
}
