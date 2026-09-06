/**
 * 服务项目领域只读工具 (29 §6.2)
 */

import type { CommandContext } from '@gf/contracts';
import { withTenant } from '@gf/db';
import { pickText } from '@gf/contracts';

export async function getServiceCatalog(
  ctx: CommandContext,
  input: Record<string, unknown>,
): Promise<unknown> {
  const search = input['search'] ? String(input['search']).trim() : null;
  const category = input['category'] ? String(input['category']).trim() : null;

  const rows = await withTenant(ctx, (tx) => tx<{
    id: string;
    name: any;
    category: string | null;
    duration_min: number;
    base_price_cents: number;
    requires_resource_type: string | null;
    active: boolean;
  }[]>`
    select id, name, category, duration_min, base_price_cents,
           requires_resource_type, active
    from services
    where location_id = ${ctx.locationId} and active = true
    order by category nulls last, name`);

  let filtered: (typeof rows)[number][] = [...rows];
  if (category) {
    filtered = filtered.filter((r) => r.category?.toLowerCase() === category.toLowerCase());
  }
  if (search) {
    const s = search.toLowerCase();
    filtered = filtered.filter((r) => {
      const nm = pickText(r.name, ctx.locale).toLowerCase();
      return nm.includes(s);
    });
  }

  return {
    count: filtered.length,
    services: filtered.map((s) => ({
      serviceId: s.id,
      name: pickText(s.name, ctx.locale),
      category: s.category ?? '未分类',
      durationMin: s.duration_min,
      priceDollars: (s.base_price_cents / 100).toFixed(2),
      priceCents: s.base_price_cents,
      resourceType: s.requires_resource_type,
    })),
  };
}
