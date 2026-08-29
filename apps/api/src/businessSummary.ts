import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import { businessSummarySchema, generateBusinessSummary, type BusinessSummary } from '@gf/ai';
import { jsonb, withTenant } from '@gf/db';
import type { CommandContext } from '@gf/contracts';

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
  // ── ① 一个事务里完成「读数据 + 查缓存」──────────────────────────────────
  // 原来的三个独立 withTenant 调用之间有竞态窗口，而且每次都要重新
  // set_config(app.org_id/location_id)。合并为两步：一次读、一次写。
  const { facts, hash, cachedEntry } = await withTenant(ctx, async (tx) => {
    const facts = await loadFacts(tx, ctx);
    const canonical = JSON.stringify({ locale: ctx.locale, facts });
    const hash = createHash('sha256').update(canonical).digest('hex');

    const [cached] = await tx<{ content: unknown; generated_at: string }[]>`
      select content, generated_at::text as generated_at from ai_business_summaries
      where location_id = ${ctx.locationId} and input_facts_sha256 = ${hash}
        and generator_version = 'claude-sonnet-5'
      order by generated_at desc limit 1`;

    return { facts, hash, cachedEntry: cached ?? null };
  });

  // 缓存命中
  if (cachedEntry) {
    const cachedContent = businessSummarySchema.safeParse(cachedEntry.content);
    if (cachedContent.success) {
      return { ...cachedContent.data, generatedAt: cachedEntry.generated_at };
    }
  }


  // ── ② AI 调用在事务外 ————————————————————————————————————————————————
  // AI 可能需要几秒钟，在事务内会持续占用一个连接和快照。
  const generated = await generateBusinessSummary({ apiKey, facts, locale: ctx.locale });

  // ── ③ 写入结果 ———————————————————————————————————————————————————————
  const [saved] = await withTenant(ctx, (tx) => tx<{ generated_at: string }[]>`
    insert into ai_business_summaries
      (org_id, location_id, period_start, period_end, generator, generator_version,
       input_facts_sha256, input_record_count, content)
    values (${ctx.orgId}, ${ctx.locationId}, ${facts.periodStart}, ${facts.periodEnd},
      'anthropic', ${generated.model}, ${hash}, ${facts.tickets}, ${jsonb(generated.content)}::jsonb)
    on conflict (location_id, input_facts_sha256, generator_version) do nothing
    returning generated_at::text`);

  if (saved) return { ...generated.content, generatedAt: saved.generated_at };

  // 并发写入时 ON CONFLICT DO NOTHING，捞出赢家的时间戳
  const [winner] = await withTenant(ctx, (tx) => tx<{ generated_at: string }[]>`
    select generated_at::text as generated_at from ai_business_summaries
    where location_id = ${ctx.locationId} and input_facts_sha256 = ${hash}
      and generator_version = ${generated.model}`);
  return { ...generated.content, generatedAt: winner!.generated_at };
}
