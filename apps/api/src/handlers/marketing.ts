/**
 * 营销体系命令处理器（P1 次卡套餐 / 优惠券 / 会员积分）
 */

import {
  packageSaveTemplate, packageIssue, packageRedeem,
  marketingIssuePackage, marketingRedeemPackage,
  couponSaveTemplate, marketingSaveCouponTemplate,
  couponVoid, marketingVoidCoupon,
  loyaltySaveRules, loyaltyAdjustPoints, marketingAdjustLoyaltyPoints,
  AppError, ERROR_CODES, asInt } from '@gf/contracts';
import { jsonb } from '@gf/db';
import { registerHandler } from '../bus';

// ─────────────────────────────────────────────────────────── 套餐次卡 (Packages)

registerHandler(packageSaveTemplate, async ({ input, ctx, tx, audit }) => {
  const nameJson = typeof input.name === 'string'
    ? { en: input.name, 'zh-Hans': input.name }
    : input.name;

  if (input.templateId) {
    const [tpl] = await tx<{ id: string }[]>`
      select id from package_templates
      where id = ${input.templateId} and org_id = ${ctx.orgId}`;
    if (!tpl) {
      throw new AppError(ERROR_CODES.NOT_FOUND, {
        details: { entity: 'package_template', id: input.templateId },
      });
    }

    const [before] = await tx<Record<string, unknown>[]>`
      select name, price_cents, sessions, service_ids, valid_days, scope, online_sale, active, sort
      from package_templates where id = ${input.templateId}`;

    await tx`
      update package_templates set
        name = ${jsonb(nameJson)}::jsonb,
        price_cents = ${input.priceCents},
        sessions = ${input.sessions},
        service_ids = ${input.serviceIds}::uuid[],
        valid_days = ${input.validDays ?? null},
        scope = ${input.scope},
        online_sale = ${input.onlineSale},
        active = ${input.active},
        sort = ${input.sort},
        updated_at = now()
      where id = ${input.templateId}`;

    const [after] = await tx<Record<string, unknown>[]>`
      select name, price_cents, sessions, service_ids, valid_days, scope, online_sale, active, sort
      from package_templates where id = ${input.templateId}`;

    audit({
      entityType: 'package_template',
      entityId: input.templateId,
      before: before ?? {},
      after: after ?? {},
    });

    return { templateId: input.templateId, created: false };
  }

  const [created] = await tx<{ id: string }[]>`
    insert into package_templates (
      org_id, location_id, name, price_cents, sessions, service_ids,
      valid_days, scope, online_sale, active, sort
    ) values (
      ${ctx.orgId}, ${ctx.locationId}, ${jsonb(nameJson)}::jsonb, ${input.priceCents},
      ${input.sessions}, ${input.serviceIds}::uuid[], ${input.validDays ?? null},
      ${input.scope}, ${input.onlineSale}, ${input.active}, ${input.sort}
    )
    returning id`;

  audit({
    entityType: 'package_template',
    entityId: created!.id,
    before: {},
    after: { name: nameJson, priceCents: input.priceCents, sessions: input.sessions },
  });

  return { templateId: created!.id, created: true };
});

const handlePackageIssue = async ({ input, ctx, tx, audit }: any) => {
  const [tpl] = await tx<{ id: string; name: unknown; price_cents: number; sessions: number; valid_days: number | null }[]>`
    select id, name, price_cents, sessions, valid_days from package_templates
    where id = ${input.templateId} and org_id = ${ctx.orgId}`;
  if (!tpl) {
    throw new AppError(ERROR_CODES.NOT_FOUND, {
      details: { entity: 'package_template', id: input.templateId },
    });
  }

  const [cust] = await tx<{ id: string }[]>`
    select id from customers where id = ${input.customerId} and org_id = ${ctx.orgId}`;
  if (!cust) {
    throw new AppError(ERROR_CODES.NOT_FOUND, {
      details: { entity: 'customer', id: input.customerId },
    });
  }

  const totalSessions = input.customSessions ?? tpl.sessions;
  const validDays = input.validDays ?? tpl.valid_days;
  const expiresAt = validDays ? new Date(Date.now() + validDays * 86400 * 1000).toISOString() : null;
  const priceCents = input.soldPriceCentsOverride ?? input.priceCentsSnapshot ?? tpl.price_cents;

  const [pkg] = await tx<{ id: string }[]>`
    insert into customer_packages (
      org_id, location_id, template_id, customer_id, remaining_sessions,
      total_sessions, status, expires_at, sold_ticket_id
    ) values (
      ${ctx.orgId}, ${ctx.locationId}, ${tpl.id}, ${input.customerId},
      ${totalSessions}, ${totalSessions}, 'active', ${expiresAt}, ${input.ticketId ?? null}
    )
    returning id`;

  // 记入客人资产账本（kind = package）
  await tx`
    insert into customer_credit_ledger (
      org_id, location_id, kind, subject_id, customer_id, entry,
      amount_cents, balance_after_cents, ticket_id, actor_membership_id
    ) values (
      ${ctx.orgId}, ${ctx.locationId}, 'package', ${pkg!.id}, ${input.customerId},
      'issue', ${priceCents}, ${priceCents}, ${input.ticketId ?? null}, ${ctx.membershipId}
    )`;

  audit({
    entityType: 'customer_package',
    entityId: pkg!.id,
    before: {},
    after: {
      templateId: tpl.id,
      customerId: input.customerId,
      totalSessions,
      priceCents,
    },
  });

  return {
    packageId: pkg!.id,
    customerId: input.customerId,
    totalSessions,
    remainingSessions: totalSessions,
  };
};

registerHandler(packageIssue, handlePackageIssue);
registerHandler(marketingIssuePackage, handlePackageIssue);

const handlePackageRedeem = async ({ input, ctx, tx, audit }: any) => {
  const targetPkgId = input.customerPackageId || input.packageId;
  const redeemUnits = input.units ?? input.sessions ?? 1;

  const [pkg] = await tx<{
    id: string; customer_id: string; remaining_sessions: number;
    total_sessions: number; status: string; expires_at: string | null;
  }[]>`
    select id, customer_id, remaining_sessions, total_sessions, status, expires_at::text
    from customer_packages
    where id = ${targetPkgId} and org_id = ${ctx.orgId} for update`;
  if (!pkg) {
    throw new AppError(ERROR_CODES.NOT_FOUND, {
      details: { entity: 'customer_package', id: targetPkgId },
    });
  }

  if (pkg.status !== 'active') {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: { reason: 'package_not_active', status: pkg.status },
    });
  }

  if (pkg.expires_at && new Date(pkg.expires_at) < new Date()) {
    await tx`update customer_packages set status = 'expired' where id = ${pkg.id}`;
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: { reason: 'package_expired', expiresAt: pkg.expires_at },
    });
  }

  // 0 代表无限次套餐
  let nextRemaining = pkg.remaining_sessions;
  if (pkg.total_sessions > 0) {
    if (pkg.remaining_sessions < redeemUnits) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
        details: {
          reason: 'insufficient_sessions',
          remaining: pkg.remaining_sessions,
          requested: redeemUnits,
        },
      });
    }
    nextRemaining = pkg.remaining_sessions - redeemUnits;
  }

  const nextStatus = (pkg.total_sessions > 0 && nextRemaining <= 0) ? 'depleted' : 'active';

  await tx`
    update customer_packages set
      remaining_sessions = ${nextRemaining},
      status = ${nextStatus},
      updated_at = now()
    where id = ${pkg.id}`;

  const customerId = input.customerId || pkg.customer_id;

  // 账本记核销
  await tx`
    insert into customer_credit_ledger (
      org_id, location_id, kind, subject_id, customer_id, entry,
      amount_cents, balance_after_cents, ticket_id, reason, actor_membership_id
    ) values (
      ${ctx.orgId}, ${ctx.locationId}, 'package', ${pkg.id}, ${customerId},
      'redeem', ${-redeemUnits}, ${nextRemaining}, ${input.ticketId ?? null},
      ${input.reason ?? null}, ${ctx.membershipId}
    )`;

  audit({
    entityType: 'customer_package',
    entityId: pkg.id,
    before: { remainingSessions: pkg.remaining_sessions, status: pkg.status },
    after: { remainingSessions: nextRemaining, status: nextStatus, redeemedSessions: redeemUnits },
  });

  return {
    packageId: pkg.id,
    remainingSessions: nextRemaining,
    redeemedSessions: redeemUnits,
    status: nextStatus as 'active' | 'depleted' | 'expired' | 'void',
  };
};

registerHandler(packageRedeem, handlePackageRedeem);
registerHandler(marketingRedeemPackage, handlePackageRedeem);

// ─────────────────────────────────────────────────────────── 优惠券 (Coupons)

const handleCouponSave = async ({ input, ctx, tx, audit }: any) => {
  const nameJson = typeof input.name === 'string'
    ? { en: input.name, 'zh-Hans': input.name }
    : input.name;

  if (input.templateId) {
    const [existing] = await tx<{ id: string }[]>`
      select id from coupon_templates
      where id = ${input.templateId} and org_id = ${ctx.orgId}`;
    if (!existing) {
      throw new AppError(ERROR_CODES.NOT_FOUND, {
        details: { entity: 'coupon_template', id: input.templateId },
      });
    }

    await tx`
      update coupon_templates set
        code = ${input.code},
        name = ${jsonb(nameJson)}::jsonb,
        kind = ${input.kind},
        discount_cents = ${input.discountCents},
        percent_bp = ${input.percentBp},
        min_spend_cents = ${input.minSpendCents},
        valid_from = ${input.validFrom ?? null},
        valid_until = ${input.validUntil ?? null},
        max_uses = ${input.maxUses ?? null},
        active = ${input.active},
        updated_at = now()
      where id = ${input.templateId}`;

    audit({
      entityType: 'coupon_template',
      entityId: input.templateId,
      before: {},
      after: { code: input.code, kind: input.kind },
    });

    return { templateId: input.templateId, code: input.code, created: false };
  }

  const [created] = await tx<{ id: string }[]>`
    insert into coupon_templates (
      org_id, location_id, code, name, kind, discount_cents,
      percent_bp, min_spend_cents, valid_from, valid_until, max_uses, active
    ) values (
      ${ctx.orgId}, ${ctx.locationId}, ${input.code}, ${jsonb(nameJson)}::jsonb,
      ${input.kind}, ${input.discountCents}, ${input.percentBp}, ${input.minSpendCents},
      ${input.validFrom ?? null}, ${input.validUntil ?? null}, ${input.maxUses ?? null}, ${input.active}
    )
    returning id`;

  audit({
    entityType: 'coupon_template',
    entityId: created!.id,
    before: {},
    after: { code: input.code, kind: input.kind },
  });

  return { templateId: created!.id, code: input.code, created: true };
};

registerHandler(couponSaveTemplate, handleCouponSave);
registerHandler(marketingSaveCouponTemplate, handleCouponSave);

const handleCouponVoid = async ({ input, ctx, tx, audit }: any) => {
  const [coupon] = await tx<{ id: string; code: string; active: boolean }[]>`
    select id, code, active from coupon_templates
    where id = ${input.couponId} and org_id = ${ctx.orgId}`;
  if (!coupon) {
    throw new AppError(ERROR_CODES.NOT_FOUND, {
      details: { entity: 'coupon_template', id: input.couponId },
    });
  }

  await tx`
    update coupon_templates set
      active = false,
      updated_at = now()
    where id = ${input.couponId}`;

  audit({
    entityType: 'coupon_template',
    entityId: input.couponId,
    before: { active: coupon.active },
    after: { active: false, reason: input.reason ?? null },
  });

  return { couponId: input.couponId, voided: true };
};

registerHandler(couponVoid, handleCouponVoid);
registerHandler(marketingVoidCoupon, handleCouponVoid);

// ─────────────────────────────────────────────────────────── 会员积分 (Loyalty)

registerHandler(loyaltySaveRules, async ({ input, ctx, tx, audit }) => {
  const [loc] = await tx<{ settings: Record<string, unknown> }[]>`
    select settings from locations where id = ${ctx.locationId}`;

  const currentSettings = loc?.settings ?? {};
  const updatedSettings = {
    ...currentSettings,
    loyalty: {
      enabled: input.enabled,
      earnRateCentsPerPoint: input.earnRateCentsPerPoint,
      redeemCentsPerPoint: input.redeemCentsPerPoint,
      minRedeemPoints: input.minRedeemPoints,
    },
  };

  await tx`
    update locations
    set settings = ${jsonb(updatedSettings)}::jsonb, updated_at = now()
    where id = ${ctx.locationId}`;

  audit({
    entityType: 'location_settings',
    entityId: ctx.locationId,
    before: { loyalty: currentSettings['loyalty'] ?? null },
    after: { loyalty: updatedSettings.loyalty },
  });

  return { saved: true };
});

const handleLoyaltyAdjustPoints = async ({ input, ctx, tx, audit }: any) => {
  const [cust] = await tx<{ id: string; display_name: string }[]>`
    select id, display_name from customers
    where id = ${input.customerId} and org_id = ${ctx.orgId} for update`;
  if (!cust) {
    throw new AppError(ERROR_CODES.NOT_FOUND, {
      details: { entity: 'customer', id: input.customerId },
    });
  }

  const delta = input.pointsDelta ?? input.deltaPoints ?? 0;

  // 计算当前积分余额
  const [balanceRow] = await tx<{ total: string }[]>`
    select coalesce(sum(amount_cents), 0)::text as total
    from customer_credit_ledger
    where kind = 'points' and customer_id = ${input.customerId}`;

  const beforePoints = asInt(balanceRow?.total, 0);
  const afterPoints = beforePoints + delta;

  if (afterPoints < 0) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: { reason: 'points_cannot_be_negative', current: beforePoints, delta },
    });
  }

  await tx`
    insert into customer_credit_ledger (
      org_id, location_id, kind, subject_id, customer_id, entry,
      amount_cents, balance_after_cents, reason, actor_membership_id
    ) values (
      ${ctx.orgId}, ${ctx.locationId}, 'points', ${input.customerId}, ${input.customerId},
      'adjust', ${delta}, ${afterPoints}, ${input.reason}, ${ctx.membershipId}
    )`;

  audit({
    entityType: 'customer_loyalty',
    entityId: input.customerId,
    before: { points: beforePoints },
    after: { points: afterPoints, delta, reason: input.reason },
  });

  return {
    customerId: input.customerId,
    deltaPoints: delta,
    currentPoints: afterPoints,
  };
};

registerHandler(loyaltyAdjustPoints, handleLoyaltyAdjustPoints);
registerHandler(marketingAdjustLoyaltyPoints, handleLoyaltyAdjustPoints);
