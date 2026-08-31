import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import { businessSummarySchema, generateBusinessSummary, type BusinessSummary } from '@gf/ai';
import { withTenant } from '@gf/db';
import { AppError, ERROR_CODES, type CommandContext } from '@gf/contracts';
import { dispatch } from './bus';

/** Same frozen statuses as bus.ts. Checked before the model call so we do not burn tokens on a frozen shop. Dispatch still enforces freeze on the write. */
const FROZEN_STATUSES = new Set(['past_due', 'canceled', 'unpaid', 'incomplete_expired']);

interface SummaryFacts {
  periodStart: string;
  periodEnd: string;
  tickets: number;
  revenueCents: number;
  discountCents: number;
  tipsCents: number;
  refundsCents: number;
  newCustomers: number;
  returningCustomers: number;
  topServices: Array<{ name: string; count: number; revenueCents: number }>;
}
async function loadFacts(tx: postgres.TransactionSql, ctx: CommandContext): Promise<SummaryFacts> {
  const [totals] = await tx<{
    period_start: string; period_end: string; tickets: number; revenue: number;
    discounts: number; tips: number; refunds: number; new_customers: number; returning_customers: number;
  }[]>`select (current_date - 29)::text as period_start, current_date::text as period_end,
      count(*)::int as tickets, coalesce(sum(total_cents), 0)::int as revenue,
      coalesce(sum(discount_cents), 0)::int as discounts, coalesce(sum(tip_cents), 0)::int as tips,
      coalesce((select sum(amount_cents) from ticket_refunds where location_id = ${ctx.locationId}
        and created_at >= current_date - 29), 0)::int as refunds,
      count(*) filter (where customer_id is not null and
        not exists (select 1 from tickets older where older.customer_id = tickets.customer_id
          and older.business_date < tickets.business_date and older.status = 'closed'))::int as new_customers,
      count(*) filter (where customer_id is not null and
        exists (select 1 from tickets older where older.customer_id = tickets.customer_id
          and older.business_date < tickets.business_date and older.status = 'closed'))::int as returning_customers
    from tickets where location_id = ${ctx.locationId}
      and business_date between current_date - 29 and current_date and status = 'closed'`;
  const services = await tx<{ name: unknown; count: number; revenue: number }[]>`
    select s.name, count(*)::int as count, coalesce(sum(ti.total_cents), 0)::int as revenue
    from ticket_items ti join tickets t on t.id = ti.ticket_id
    left join services s on s.id = ti.service_id
    where t.location_id = ${ctx.locationId} and t.business_date between current_date - 29 and current_date
      and t.status = 'closed' and ti.kind in ('service', 'addon')
    group by s.id, s.name order by revenue desc limit 5`;
  return {
    periodStart: totals!.period_start, periodEnd: totals!.period_end, tickets: totals!.tickets,
    revenueCents: totals!.revenue, discountCents: totals!.discounts, tipsCents: totals!.tips,
    refundsCents: totals!.refunds, newCustomers: totals!.new_customers,
    returningCustomers: totals!.returning_customers,
    topServices: services.map((row) => ({
      name: typeof row.name === 'string' ? row.name : String((row.name as Record<string, string> | null)?.[ctx.locale] ?? (row.name as Record<string, string> | null)?.['en'] ?? 'Service'),
      count: row.count, revenueCents: row.revenue,
    })),
  };
}

export async function generateAndSaveBusinessSummary(ctx: CommandContext, apiKey: string): Promise<BusinessSummary & { generatedAt: string }> {
  if (!ctx.permissions.has('report.view')) {
    throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'report.view' } });
  }

  // ── ① 读事实 + 查缓存。不在这里写库。──────────────────────────────────
  const { facts, hash, cachedEntry, frozenStatus } = await withTenant(ctx, async (tx) => {
    const facts = await loadFacts(tx, ctx);
    const canonical = JSON.stringify({ locale: ctx.locale, facts });
    const hash = createHash('sha256').update(canonical).digest('hex');

    const [cached] = await tx<{ content: unknown; generated_at: string }[]>`
      select content, generated_at::text as generated_at from ai_business_summaries
      where location_id = ${ctx.locationId} and input_facts_sha256 = ${hash}
        and generator_version = 'claude-sonnet-5'
      order by generated_at desc limit 1`;

    const [acct] = await tx<{ status: string }[]>`
      select subscription_status as status
      from billing_accounts where location_id = ${ctx.locationId}`;

    return {
      facts,
      hash,
      cachedEntry: cached ?? null,
      frozenStatus: acct?.status ?? null,
    };
  });

  if (cachedEntry) {
    const cachedContent = businessSummarySchema.safeParse(cachedEntry.content);
    if (cachedContent.success) {
      return { ...cachedContent.data, generatedAt: cachedEntry.generated_at };
    }
  }

  if (frozenStatus && FROZEN_STATUSES.has(frozenStatus)) {
    throw new AppError(ERROR_CODES.SUBSCRIPTION_PAST_DUE, {
      details: { command: 'analytics.saveBusinessSummary', subscriptionStatus: frozenStatus },
    });
  }

  // ── ② AI 调用在事务外 ───────────────────────────────────────────────
  const generated = await generateBusinessSummary({ apiKey, facts, locale: ctx.locale });

  // ── ③ 写入走命令总线：权限、冻结、租户事务、审计 ─────────────────────
  const { result } = await dispatch<BusinessSummary & { generatedAt: string; summaryId: string }>(
    'analytics.saveBusinessSummary',
    {
      periodStart: facts.periodStart,
      periodEnd: facts.periodEnd,
      generator: 'anthropic',
      generatorVersion: generated.model,
      inputFactsSha256: hash,
      inputRecordCount: facts.tickets,
      content: generated.content,
    },
    ctx, { systemOrigin: 'anthropic_usage' });

  return {
    highlights: result.highlights,
    risks: result.risks,
    actions: result.actions,
    generatedAt: result.generatedAt,
  };
}
