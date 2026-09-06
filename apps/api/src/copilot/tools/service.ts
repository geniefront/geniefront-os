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
    duration_min: number;
    base_price_cents: number;
    active: boolean;
    category_name: any;
  }[]>`
    select s.id, s.name, s.duration_min, s.base_price_cents, s.active,
           sc.name as category_name
    from services s
    left join service_categories sc on sc.id = s.category_id
    where s.location_id = ${ctx.locationId} and s.active = true
    order by sc.sort nulls last, s.sort nulls last, s.name`);

  let filtered: (typeof rows)[number][] = [...rows];
  if (category) {
    const c = category.toLowerCase();
    filtered = filtered.filter((r) => {
      const catZh = r.category_name ? pickText(r.category_name, ctx.locale).toLowerCase() : '';
      const catEn = typeof r.category_name === 'object' && r.category_name ? String(r.category_name['en'] || '').toLowerCase() : '';
      return catZh.includes(c) || catEn.includes(c);
    });
  }
  if (search) {
    const s = search.toLowerCase();
    filtered = filtered.filter((r) => {
      const nameZh = pickText(r.name, ctx.locale).toLowerCase();
      const nameEn = typeof r.name === 'object' && r.name ? String(r.name['en'] || '').toLowerCase() : '';
      const catZh = r.category_name ? pickText(r.category_name, ctx.locale).toLowerCase() : '';
      const catEn = typeof r.category_name === 'object' && r.category_name ? String(r.category_name['en'] || '').toLowerCase() : '';
      return nameZh.includes(s) || nameEn.includes(s) || catZh.includes(s) || catEn.includes(s);
    });
  }

  return {
    count: filtered.length,
    services: filtered.map((s) => ({
      serviceId: s.id,
      name: pickText(s.name, ctx.locale),
      englishName: typeof s.name === 'object' && s.name ? (s.name['en'] || s.name['en-US'] || null) : null,
      category: s.category_name ? pickText(s.category_name, ctx.locale) : '未分类',
      durationMin: s.duration_min,
      priceDollars: (s.base_price_cents / 100).toFixed(2),
      priceCents: s.base_price_cents,
      resourceType: null,
    })),
  };
}
