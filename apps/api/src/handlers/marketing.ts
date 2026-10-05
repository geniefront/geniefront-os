import { canonicalCustomer, customerAssetIds } from '../customerIdentity';
/**
 * 营销体系命令处理器（P1 次卡套餐 / 优惠券 / 会员积分）
 */

import {
  packageSaveTemplate, packageIssue, packageRedeem,
  marketingIssuePackage, marketingRedeemPackage,packageRestore,
  couponSaveTemplate, marketingSaveCouponTemplate,
  couponVoid, marketingVoidCoupon,
  loyaltySaveRules, loyaltyAdjustPoints, marketingAdjustLoyaltyPoints,
  AppError, ERROR_CODES, asInt } from '@gf/contracts';
import { jsonb } from '@gf/db';
import {formatPackageUnitRanges,parsePackageUnitRanges,restorePackageUnits,packageRangeCount} from '@gf/payroll';
import {allocatePackageUse,availablePackageUnits} from './packageUnits';
import { registerHandler } from '../bus';

// ─────────────────────────────────────────────────────────── 套餐次卡 (Packages)

registerHandler(packageSaveTemplate, async ({ input, ctx, tx, audit }) => {
  const nameJson = typeof input.name === 'string'
    ? { en: input.name, 'zh-Hans': input.name }
    : input.name;
  const serviceIds = [...new Set(input.serviceIds)];
  if(input.sessions===0&&(!input.validDays||serviceIds.length===0)) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED,{details:{reason:'unlimited_requires_term_and_services'}});
  }

  if (serviceIds.length > 0) {
    const validServices = await tx<{ id: string }[]>`
      select id from services
      where location_id = ${ctx.locationId} and active = true and id = any(${serviceIds})`;
    if (validServices.length !== serviceIds.length) {
      throw new AppError(ERROR_CODES.NOT_FOUND, {
        details: { entity: 'service', reason: 'package_service_not_active_or_wrong_location' },
      });
    }
  }

  if (input.templateId) {
    const [tpl] = await tx<{ id: string }[]>`
      select id from package_templates
      where id = ${input.templateId} and org_id = ${ctx.orgId} and location_id=${ctx.locationId}`;
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
        service_ids = ${serviceIds}::uuid[],
        valid_days = ${input.validDays ?? null},
        scope = ${input.scope},
        online_sale = ${input.onlineSale},
        coverage_mode=${input.coverageMode??null},commission_basis=${input.commissionBasis??null},
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
      valid_days, scope, online_sale, active, sort,coverage_mode,commission_basis
    ) values (
      ${ctx.orgId}, ${ctx.locationId}, ${jsonb(nameJson)}::jsonb, ${input.priceCents},
      ${input.sessions}, ${serviceIds}::uuid[], ${input.validDays ?? null},
      ${input.scope}, ${input.onlineSale}, ${input.active}, ${input.sort},${input.coverageMode??null},${input.commissionBasis??null}
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

/**
 * 校验传入的 customerId 确属本租户且未被合并 / 拉黑，返回同一个 id。
 */
const assertCustomer = async (tx: any, ctx: any, customerId: string): Promise<string> => {
  const [cust] = await tx<{ id: string }[]>`
    select id from customers
    where id = ${customerId} and org_id = ${ctx.orgId}
      and merged_into_id is null and blocked_at is null`;
  if (!cust) {
    throw new AppError(ERROR_CODES.NOT_FOUND, {
      details: { entity: 'customer', id: customerId },
    });
  }
  return cust.id;
};

/**
 * 前台发售次卡时只报了客人姓名（可选附手机号），在此解析成真实客户 id。
 *
 * 语义完全对齐 appointment.ts 的 resolveGuestCustomer：
 *   · 仅当「手机号 + 姓名都一模一样且库里只有一条」时复用既有客户；
 *   · 没给手机号，或匹配到 0 / 多条，一律新建 —— 不猜、不按手机号单独合并
 *     （宪法第 16 条：猜错会把两个人的消费记录并到一起，且不可逆）。
 *   · 手滑建重的记录事后由前台用 customer.merge 收口。
 */
const resolvePackageCustomer = async (
  tx: any,
  ctx: any,
  c: { name: string; phoneE164?: string; email?: string },
): Promise<string> => {
  const name = c.name.trim();

  if (c.phoneE164) {
    const same = await tx<{ id: string }[]>`
      select id from customers
      where org_id = ${ctx.orgId}
        and phone_e164 = ${c.phoneE164}
        and lower(trim(display_name)) = lower(${name})
        and merged_into_id is null
        and blocked_at is null
      limit 2`;
    if (same.length === 1) {
      // 邮箱只在原来没有时补，不覆盖前台后来维护过的那一版。
      if (c.email) {
        await tx`
          update customers set email = ${c.email}
          where id = ${same[0]!.id} and (email is null or email = '')`;
      }
      return same[0]!.id;
    }
  }

  const [row] = await tx<{ id: string }[]>`
    insert into customers
      (org_id, primary_location_id, display_name, phone_e164, email, source)
    values
      (${ctx.orgId}, ${ctx.locationId}, ${name}, ${c.phoneE164 ?? null},
       ${c.email ?? null}, 'desk')
    returning id`;
  return row!.id;
};

const handlePackageIssue = async (args: any) => {
  const {input,ctx,tx}=args;
  if(input.ticketId)throw new AppError(ERROR_CODES.VALIDATION_FAILED,{details:{reason:'use_commerce_purchase'}});
  const [existing]=await tx<{customer_id:string}[]>`select customer_id from commerce_orders where location_id=${ctx.locationId} and idem_key=${input.businessKey}`;
  const customerId=existing?.customer_id??(input.customerId?await assertCustomer(tx,ctx,input.customerId):await resolvePackageCustomer(tx,ctx,input.customer));
  const hasOverrides=input.soldPriceCentsOverride!==undefined||input.priceCentsSnapshot!==undefined||input.customSessions!==undefined||input.validDays!==undefined;
  const {commercePurchaseInput}=await import('@gf/contracts');
  const {createOrderInTransaction}=await import('./commerce');
  const order=await createOrderInTransaction({...args,input:commercePurchaseInput.parse({...input,kind:'package',customerId,customer:undefined,
    ...(hasOverrides?{packageOverrides:{priceCents:input.soldPriceCentsOverride??input.priceCentsSnapshot,sessions:input.customSessions,validDays:input.validDays}}:{})})},input);
  const [pkg]=await tx<{id:string;total_sessions:number;remaining_sessions:number}[]>`
    select id,total_sessions,remaining_sessions from customer_packages where id=${order.assetId}`;
  if(!pkg)throw new AppError(ERROR_CODES.INTERNAL);
  return {packageId:pkg.id,customerId,totalSessions:pkg.total_sessions,remainingSessions:pkg.remaining_sessions};
};

registerHandler(packageIssue, handlePackageIssue);
registerHandler(marketingIssuePackage, handlePackageIssue);
registerHandler(packageRestore,async({input,ctx,tx,audit})=>{
  const [original]=await tx<{id:string;package_id:string;quantity:number;value_cents:number;unit_ranges:string|null;ticket_id:string|null}[]>`
    select * from customer_package_ledger where id=${input.redemptionId} and entry='redeem'`;
  if(!original)throw new AppError(ERROR_CODES.NOT_FOUND,{details:{entity:'package_redemption'}});
  const [pkg]=await tx<{id:string;total_sessions:number;remaining_sessions:number;reserved_sessions:number;available_units:string;
    status:string;expires_at:string|null;refund_frozen:boolean;commerce_frozen:boolean;purchase_snapshot:{unitAllocationVersion?:number}|null;customer_id:string}[]>`
    select * from customer_packages where id=${original.package_id} for update`;
  if(!pkg)throw new AppError(ERROR_CODES.NOT_FOUND);
  const [restored]=await tx<{id:string}[]>`select id from customer_package_ledger where package_id=${pkg.id} and reference=${`restore:${original.id}`}`;
  if(restored){audit({entityType:'customer_package',entityId:pkg.id,after:{restorationReplayed:true}});return {packageId:pkg.id,restoredSessions:-original.quantity,remainingSessions:pkg.remaining_sessions};}
  if(pkg.status==='void'||pkg.status==='expired'||pkg.refund_frozen||pkg.commerce_frozen||(pkg.expires_at&&new Date(pkg.expires_at)<new Date()))
    throw new AppError(ERROR_CODES.VALIDATION_FAILED,{details:{reason:'package_unavailable'}});
  if(original.ticket_id){const [ticket]=await tx<{status:string;service_settled_at:string|null}[]>`select status,service_settled_at from tickets where id=${original.ticket_id}`;
    if(!ticket||ticket.service_settled_at||['closed','refunded'].includes(ticket.status))throw new AppError(ERROR_CODES.VALIDATION_FAILED,{details:{reason:'use_ticket_refund_for_service'}});}
  if(original.unit_ranges===null)throw new AppError(ERROR_CODES.VALIDATION_FAILED,{details:{reason:'historical_redemption_requires_review'}});
  const units=-original.quantity,returned=parsePackageUnitRanges(original.unit_ranges,pkg.total_sessions);
  if(units<=0||(pkg.total_sessions>0&&packageRangeCount(returned)!==units))throw new AppError(ERROR_CODES.VALIDATION_FAILED,{details:{reason:'package_redemption_inconsistent'}});
  const available=pkg.total_sessions>0?restorePackageUnits(availablePackageUnits(pkg),returned):[];
  const next=pkg.total_sessions>0?pkg.remaining_sessions+units:pkg.remaining_sessions;
  if(pkg.total_sessions>0&&next>pkg.total_sessions)throw new AppError(ERROR_CODES.VALIDATION_FAILED,{details:{reason:'package_restore_exceeds_purchase'}});
  await tx`insert into customer_package_ledger(org_id,location_id,package_id,entry,quantity,value_cents,ticket_id,reference,reversal_of_id,unit_ranges)
    values(${ctx.orgId},${ctx.locationId},${pkg.id},'restore',${units},${-original.value_cents},${original.ticket_id},${`restore:${original.id}`},${original.id},${original.unit_ranges}::int4multirange)`;
  await tx`insert into customer_credit_ledger(org_id,location_id,kind,subject_id,customer_id,entry,amount_cents,balance_after_cents,ticket_id,reason,actor_membership_id,meta)
    values(${ctx.orgId},${ctx.locationId},'package',${pkg.id},${pkg.customer_id},'refund',${units},${next},${original.ticket_id},${input.reason},${ctx.membershipId},${jsonb({redemptionId:original.id,unit:'sessions'})}::jsonb)`;
  await tx`update customer_packages set remaining_sessions=${next},available_units=${formatPackageUnitRanges(available)}::int4multirange,status='active',updated_at=now() where id=${pkg.id}`;
  audit({entityType:'customer_package',entityId:pkg.id,after:{restoredSessions:units,redemptionId:original.id,reason:input.reason}});
  return {packageId:pkg.id,restoredSessions:units,remainingSessions:next};
});

const handlePackageRedeem = async ({ input, ctx, tx, audit }: any) => {
  const targetPkgId = input.customerPackageId || input.packageId;
  const redeemUnits = input.units ?? input.sessions ?? 1;

  const [pkg] = await tx<{
    id: string; customer_id: string; remaining_sessions: number;
    total_sessions: number; status: string; expires_at: string | null; service_ids: string[];reserved_sessions:number;refund_frozen:boolean;commerce_frozen:boolean;
    location_id:string;scope:string;sold_price_cents:number;available_units:string;purchase_snapshot:{unitAllocationVersion?:number}|null;
  }[]>`
    select cp.id, cp.customer_id, cp.remaining_sessions, cp.total_sessions, cp.status,
           cp.expires_at::text,
           case when cp.purchase_snapshot is not null then array(select jsonb_array_elements_text(cp.purchase_snapshot->'serviceIds'))
                else coalesce(pt.service_ids,'{}')::text[] end as service_ids,
           cp.reserved_sessions,cp.refund_frozen,cp.commerce_frozen,cp.available_units,cp.purchase_snapshot,cp.location_id,coalesce(cp.purchase_snapshot->>'scope',pt.scope,'location') as scope,
           coalesce((cp.purchase_snapshot->>'amountCents')::int,0) as sold_price_cents
    from customer_packages cp
    left join package_templates pt on pt.id = cp.template_id
    where cp.id = ${targetPkgId} and cp.org_id = ${ctx.orgId} for update of cp`;
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
  if((pkg.scope!=='org'&&pkg.location_id!==ctx.locationId)||pkg.refund_frozen||pkg.commerce_frozen)throw new AppError(ERROR_CODES.VALIDATION_FAILED,{details:{reason:'package_unavailable'}});

  if (pkg.expires_at && new Date(pkg.expires_at) < new Date()) {
    await tx`update customer_packages set status = 'expired' where id = ${pkg.id}`;
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: { reason: 'package_expired', expiresAt: pkg.expires_at },
    });
  }

  if (input.customerId && await canonicalCustomer(tx,input.customerId) !== await canonicalCustomer(tx,pkg.customer_id)) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: { reason: 'package_customer_mismatch' },
    });
  }

  if (input.ticketId) {
    const [ticket] = await tx<{ customer_id: string | null }[]>`
      select customer_id from tickets
      where id = ${input.ticketId} and location_id = ${ctx.locationId}`;
    if (!ticket) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'ticket' } });
    if (!ticket.customer_id || await canonicalCustomer(tx,ticket.customer_id) !== await canonicalCustomer(tx,pkg.customer_id)) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
        details: { reason: 'package_ticket_customer_mismatch' },
      });
    }

    const idemKey = `package-redeem-${pkg.id}-${input.ticketId}`;
    const [duplicate] = await tx<{ id: string }[]>`
      select id from customer_credit_ledger
      where location_id = ${ctx.locationId} and idem_key = ${idemKey}`;
    if (duplicate) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
        details: { reason: 'package_already_redeemed_for_ticket' },
      });
    }

    if (pkg.service_ids.length > 0) {
      const itemCounts = await tx<{ service_id: string; count: number }[]>`
        select service_id, count(*)::int as count from ticket_items
        where ticket_id = ${input.ticketId} and service_id = any(${pkg.service_ids}) and bundle_instance_id is null
        group by service_id`;
      const countByService = new Map(itemCounts.map(
        (row: { service_id: string; count: number }) => [row.service_id, row.count],
      ));
      const missing = pkg.service_ids.filter(
        (serviceId: string) => (countByService.get(serviceId) ?? 0) < redeemUnits,
      );
      if (missing.length > 0) {
        throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
          details: { reason: 'package_services_not_on_ticket', serviceIds: missing },
        });
      }
    }
  }

  // 0 代表无限次套餐
  let nextRemaining = pkg.remaining_sessions;
  if (pkg.total_sessions > 0) {
    if (pkg.remaining_sessions-pkg.reserved_sessions < redeemUnits) {
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
  const allocation=allocatePackageUse(pkg,pkg.sold_price_cents,redeemUnits);

  await tx`
    update customer_packages set
      remaining_sessions = ${nextRemaining},
      status = ${nextStatus},available_units=${formatPackageUnitRanges(allocation.remaining)}::int4multirange,
      updated_at = now()
    where id = ${pkg.id}`;

  const customerId = input.customerId || pkg.customer_id;
  await tx`insert into customer_package_ledger(org_id,location_id,package_id,entry,quantity,value_cents,ticket_id,reference,unit_ranges)
    values(${ctx.orgId},${ctx.locationId},${pkg.id},'redeem',${-redeemUnits},${-allocation.valueCents},${input.ticketId??null},${input.ticketId?`ticket:${input.ticketId}`:crypto.randomUUID()},${formatPackageUnitRanges(allocation.taken)}::int4multirange)`;

  // 账本记核销
  await tx`
    insert into customer_credit_ledger (
      org_id, location_id, kind, subject_id, customer_id, entry,
      amount_cents, balance_after_cents, ticket_id, reason, actor_membership_id,
      idem_key, meta
    ) values (
      ${ctx.orgId}, ${ctx.locationId}, 'package', ${pkg.id}, ${customerId},
      'redeem', ${-redeemUnits}, ${nextRemaining}, ${input.ticketId ?? null},
      ${input.reason ?? null}, ${ctx.membershipId},
      ${input.ticketId ? `package-redeem-${pkg.id}-${input.ticketId}` : null},
      ${jsonb({ serviceIds: pkg.service_ids, units: redeemUnits })}::jsonb
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
  const customerId = await canonicalCustomer(tx, input.customerId, true);
  const [cust] = await tx<{ id: string; display_name: string }[]>`
    select id, display_name from customers
    where id = ${customerId} and org_id = ${ctx.orgId} for update`;
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
    where kind = 'points' and customer_id in ${customerAssetIds(tx, customerId)}`;

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
      ${ctx.orgId}, ${ctx.locationId}, 'points', ${customerId}, ${customerId},
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
