/**
 * Yelp 一键填店的落地（05 §4.1）
 *
 * 一条原则：**只填老板勾了的，没勾的一个字节都不动**。
 *
 * 「一键填充」很容易被做成「一键覆盖」—— 老板只想要营业时间，
 * 结果店名被 Yelp 上那个八年没改的旧名字盖掉了，而他不会立刻发现。
 * 所以每个字段都是 optional，不传就 coalesce 回原值。
 */

import { ApplyYelpBusiness } from '@gf/contracts';
import { jsonb } from '@gf/db';
import { registerHandler, type HandlerArgs } from '../bus';

registerHandler(ApplyYelpBusiness, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof ApplyYelpBusiness.input._type>) => {
  const applied: string[] = [];
  if (input.name) applied.push('name');
  if (input.phone) applied.push('phone');
  if (input.address) applied.push('address');
  if (input.timezone) applied.push('timezone');
  if (input.businessHours) applied.push('businessHours');

  const [before] = await tx<{ timezone: string; name: unknown }[]>`
    select timezone, name from locations where id = ${ctx.locationId}`;

  await tx`
    update locations set
      yelp_business_id = ${input.yelpBusinessId},
      name = coalesce(${input.name ? jsonb({ en: input.name }) : null}::jsonb, name),
      phone = coalesce(${input.phone ?? null}, phone),
      address = coalesce(${input.address ? jsonb(input.address) : null}::jsonb, address),
      address_street = coalesce(${input.address?.line1 ?? null}, address_street),
      address_city = coalesce(${input.address?.city ?? null}, address_city),
      address_state = coalesce(${input.address?.state ?? null}, address_state),
      address_zip = coalesce(${input.address?.zip ?? null}, address_zip),
      timezone = coalesce(${input.timezone ?? null}, timezone),
      business_hours = coalesce(
        ${input.businessHours ? jsonb(input.businessHours) : null}::jsonb, business_hours)
    where id = ${ctx.locationId}`;

  // 权威评分进 location_review_stats（05 §8.1）。
  // 老板端的口碑趋势只依赖这一条 —— 它免费且稳定，
  // 完整评论正文的抓取（Bright Data）挂了也不影响看分数。
  if (input.ratingBp !== undefined && input.ratingBp !== null) {
    // ⚠️ 唯一索引是 (location, platform, on_date) —— 这张表是**按天**留一行的，
    // 老板端的口碑趋势图靠的就是这一串历史点。冲突键写成 (location, platform)
    // 会让每天的分数互相覆盖，趋势图上永远只有一个点。
    await tx`
      insert into location_review_stats
        (org_id, location_id, platform, on_date, rating_bp, review_count, fetched_at)
      values (${ctx.orgId}, ${ctx.locationId}, 'yelp',
              (now() at time zone (select timezone from locations where id = ${ctx.locationId}))::date,
              ${input.ratingBp}, ${input.reviewCount ?? 0}, now())
      on conflict (location_id, platform, on_date) do update set
        rating_bp = excluded.rating_bp,
        review_count = excluded.review_count,
        fetched_at = excluded.fetched_at`;
    applied.push('rating');
  }

  audit({
    entityType: 'location', entityId: ctx.locationId,
    before: { timezone: before?.timezone ?? null },
    after: {
      yelpBusinessId: input.yelpBusinessId,
      applied,
      // 时区改动单独留痕：它错了整家店的日结会错一天，
      // 而事后追查「什么时候变的」只能靠这条
      timezone: input.timezone ?? before?.timezone ?? null,
    },
  });

  return { locationId: ctx.locationId, applied };
});
