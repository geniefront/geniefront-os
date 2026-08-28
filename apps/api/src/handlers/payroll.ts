/**
 * 薪酬方案命令实现。
 *
 * 方案版本化：每次保存都是新版本，历史 earnings 一行不动。
 * 老板周三改提成率，技师周一看到的数字不会跟着变 —— 这一条是这个功能能不能被信任的前提。
 */

import {
  SavePlan, CreatePayrollBatch, MarkPayrollBatchPaid, AppError, ERROR_CODES,
  type CommandContext,
} from '@gf/contracts';
import { assertValidPlan, DEFAULT_PLAN, type CompensationPlan } from '@gf/payroll';
import { jsonb } from '@gf/db';
import { registerHandler, type HandlerArgs } from '../bus';

registerHandler(SavePlan, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof SavePlan.input._type>) => {
  const plan: CompensationPlan = {
    kind: input.kind,
    rateBp: input.rateBp,
    categoryRateBp: input.categoryRateBp,
    retailRateBp: input.retailRateBp,
    hourlyRateCents: input.hourlyRateCents,
    base: input.base,
    // 双技师营业额分摊权重跟小费默认口径一致，暂不开放单独配置：
    // 多一个旋钮就多一处能把两边调歪的地方
    roleWeightBp: DEFAULT_PLAN.roleWeightBp,
  };
  assertValidPlan(plan);

  const [prev] = await tx<{ v: number }[]>`
    select coalesce(max(version), 0)::int as v from compensation_plans
    where location_id = ${ctx.locationId}
      and membership_id is not distinct from ${input.membershipId}`;
  const version = (prev?.v ?? 0) + 1;

  const [row] = await tx<{ id: string }[]>`
    insert into compensation_plans
      (org_id, location_id, membership_id, version, config, created_by)
    values (${ctx.orgId}, ${ctx.locationId}, ${input.membershipId}, ${version},
            ${jsonb(plan)}::jsonb, ${ctx.membershipId})
    returning id`;

  // 提成率不是「金额」，照常进审计 ——
  // 「谁把提成从 45% 改成 35% 的」恰恰是最该留痕的一类操作（宪法第 17 条只管金额）
  audit({
    entityType: 'compensation_plan', entityId: row!.id,
    after: {
      membershipId: input.membershipId,
      kind: input.kind, rateBp: input.rateBp, base: input.base,
      hourlyRateCents: input.hourlyRateCents, version,
    },
  });

  return { planId: row!.id, version };
});

registerHandler(CreatePayrollBatch, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof CreatePayrollBatch.input._type>) => {
  if (input.periodEnd < input.periodStart) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, { details: { reason: 'invalid_payroll_period' } });
  }
  const [batch] = await tx<{ id: string; status: string }[]>`
    insert into payroll_batches (org_id, location_id, period_start, period_end, status)
    values (${ctx.orgId}, ${ctx.locationId}, ${input.periodStart}, ${input.periodEnd}, 'draft')
    on conflict (location_id, period_start, period_end) do update
      set period_end = excluded.period_end
    returning id, status`;
  if (batch!.status !== 'draft') {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: { reason: 'payroll_batch_is_immutable', status: batch!.status },
    });
  }
  const items = await tx<{ membership_id: string }[]>`
    insert into payroll_batch_items
      (org_id, location_id, payroll_batch_id, membership_id,
       service_sales_cents, service_commission_cents, card_tips_cents, net_pay_cents)
    select ${ctx.orgId}, ${ctx.locationId}, ${batch!.id}, e.membership_id,
           coalesce(sum(e.base_cents) filter (where e.kind = 'commission'), 0)::int,
           coalesce(sum(e.amount_cents) filter (where e.kind = 'commission'), 0)::int,
           coalesce(sum(e.amount_cents) filter (where e.kind = 'tip_card'), 0)::int,
           coalesce(sum(e.amount_cents), 0)::int
    from earnings e
    where e.location_id = ${ctx.locationId}
      and e.business_date between ${input.periodStart} and ${input.periodEnd}
      and e.reversed_at is null
    group by e.membership_id
    on conflict (payroll_batch_id, membership_id) do update set
      service_sales_cents = excluded.service_sales_cents,
      service_commission_cents = excluded.service_commission_cents,
      card_tips_cents = excluded.card_tips_cents,
      net_pay_cents = excluded.net_pay_cents
    returning membership_id`;
  audit({ entityType: 'payroll_batch', entityId: batch!.id,
          after: { periodStart: input.periodStart, periodEnd: input.periodEnd,
                   status: 'draft', itemCount: items.length } });
  return { batchId: batch!.id, itemCount: items.length, status: 'draft' as const };
});

registerHandler(MarkPayrollBatchPaid, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof MarkPayrollBatchPaid.input._type>) => {
  const [batch] = await tx<{ id: string; status: string }[]>`
    select id, status from payroll_batches where id = ${input.batchId} for update`;
  if (!batch) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'payroll_batch' } });
  if (batch.status === 'voided') {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, { details: { reason: 'payroll_batch_voided' } });
  }
  await tx`update payroll_batches set status = 'paid', paid_at = coalesce(paid_at, now()),
      approved_at = coalesce(approved_at, now()), approved_by = coalesce(approved_by, ${ctx.membershipId}),
      provider_batch_id = coalesce(provider_batch_id, ${input.providerBatchId ?? null})
    where id = ${batch.id}`;
  audit({ entityType: 'payroll_batch', entityId: batch.id,
          before: { status: batch.status }, after: { status: 'paid', note: input.note,
            providerBacked: Boolean(input.providerBatchId) } });
  return { batchId: batch.id, status: 'paid' as const };
});

export type { CommandContext };
