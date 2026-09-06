/**
 * 客户领域只读工具 (29 §6.2)
 */

import type { CommandContext } from '@gf/contracts';
import { withTenant } from '@gf/db';
import { loadCustomerDetail } from '../../queries/customer.js';

interface CustomerHit {
  id: string;
  display_name: string;
  phone_e164: string | null;
  no_show_count: number;
  last_visit_on: string | null;
}

export async function resolveCustomers(
  ctx: CommandContext,
  input: Record<string, unknown>,
): Promise<unknown> {
  const raw = String(input['query'] ?? '').trim();
  const limit = Math.min(20, Math.max(1, Number(input['limit'] ?? 5)));
  if (raw.length < 2) return { customers: [], note: '关键词太短' };

  const digits = raw.replace(/\D/g, '');
  const byPhone = digits.length >= 3;

  const rows = await withTenant(ctx, (tx) =>
    byPhone
      ? tx<CustomerHit[]>`
          select c.id, c.display_name, c.phone_e164, c.no_show_count,
                 (select max(a.business_date)::text from appointments a
                   where a.customer_id = c.id and a.status <> 'cancelled') as last_visit_on
          from customers c
          where c.merged_into_id is null
            and regexp_replace(coalesce(c.phone_e164,''), '\\D', '', 'g') like ${'%' + digits}
          order by c.display_name limit ${limit}`
      : tx<CustomerHit[]>`
          select c.id, c.display_name, c.phone_e164, c.no_show_count,
                 (select max(a.business_date)::text from appointments a
                   where a.customer_id = c.id and a.status <> 'cancelled') as last_visit_on
          from customers c
          where c.merged_into_id is null and c.display_name ilike ${'%' + raw + '%'}
          order by c.display_name limit ${limit}`,
  );

  return {
    guidance:
      rows.length > 1
        ? '找到多位同名或相似客户。必须列出供前台人工确认点选，严禁自行盲猜选择。'
        : undefined,
    customers: rows.map((r) => ({
      customerId: r.id,
      name: r.display_name,
      phone: ctx.permissions.has('customer.view_contact')
        ? r.phone_e164
        : r.phone_e164 ? `***${r.phone_e164.slice(-4)}` : null,
      lastVisitOn: r.last_visit_on,
      noShowCount: r.no_show_count,
    })),
  };
}

export async function getCustomerDetailTool(
  ctx: CommandContext,
  input: Record<string, unknown>,
): Promise<unknown> {
  const customerId = String(input['customerId'] ?? '').trim();
  if (!customerId) return { error: 'customerId 必填' };

  const detail = await withTenant(ctx, (tx) => loadCustomerDetail(tx, ctx, customerId));
  if (!detail) return { error: '客户不存在' };

  return {
    customerId: detail.id,
    name: detail.displayName,
    phone: detail.phone,
    lifetimeSpendDollars:
      detail.visits.lifetimeSpendCents != null
        ? (detail.visits.lifetimeSpendCents / 100).toFixed(2)
        : null,
    visitCount: detail.visits.total,
    noShowCount: detail.noShowCount,
    lastVisitDate: detail.visits.lastAt,
    recentTickets: detail.recentTickets,
    notes: detail.notes,
  };
}

export async function listInactiveCustomers(
  ctx: CommandContext,
  input: Record<string, unknown>,
): Promise<unknown> {
  const days = Math.max(30, Math.min(365, Number(input['days'] ?? 60)));
  const limit = Math.max(1, Math.min(20, Number(input['limit'] ?? 10)));

  const rows = await withTenant(ctx, (tx) => tx<{
    id: string; display_name: string; phone_e164: string | null; last_visit: string;
  }[]>`
    select c.id, c.display_name, c.phone_e164, max(a.business_date)::text as last_visit
    from customers c
    join appointments a on a.customer_id = c.id
    where a.status = 'completed'
    group by c.id, c.display_name, c.phone_e164
    having max(a.business_date) < (current_date - (${days} || ' days')::interval)::date
    order by max(a.business_date) asc
    limit ${limit}`);

  return {
    daysInactive: days,
    count: rows.length,
    customers: rows.map((r) => ({
      customerId: r.id,
      name: r.display_name,
      phone: ctx.permissions.has('customer.view_contact')
        ? r.phone_e164
        : r.phone_e164 ? `***${r.phone_e164.slice(-4)}` : null,
      lastVisitDate: r.last_visit,
    })),
  };
}
