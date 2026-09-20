import { ApplyGoogleBusiness } from '@gf/contracts';
import { jsonb } from '@gf/db';
import { registerHandler, type HandlerArgs } from '../bus';

registerHandler(ApplyGoogleBusiness, async ({ input, ctx, tx, audit }: HandlerArgs<typeof ApplyGoogleBusiness.input._type>) => {
  const applied: string[] = [];
  if (input.businessType) applied.push('businessType');
  if (input.name) applied.push('name'); if (input.phone) applied.push('phone');
  if (input.address) applied.push('address'); if (input.businessHours) applied.push('businessHours');
  await tx`update locations set
    google_place_id = ${input.googlePlaceId},
    business_type = coalesce(${input.businessType ?? null}, business_type),
    name = coalesce(${input.name ? jsonb({ en: input.name }) : null}::jsonb, name),
    phone = coalesce(${input.phone ?? null}, phone),
    address = coalesce(${input.address ? jsonb(input.address) : null}::jsonb, address),
    address_street = coalesce(${input.address?.line1 ?? null}, address_street),
    address_city = coalesce(${input.address?.city ?? null}, address_city),
    address_state = coalesce(${input.address?.state ?? null}, address_state),
    address_zip = coalesce(${input.address?.zip ?? null}, address_zip),
    business_hours = coalesce(${input.businessHours ? jsonb(input.businessHours) : null}::jsonb, business_hours),
    updated_at = now()
    where id = ${ctx.locationId}`;
  if (input.ratingBp !== undefined && input.ratingBp !== null) {
    await tx`insert into location_review_stats
      (org_id, location_id, platform, on_date, rating_bp, review_count, fetched_at)
      values (${ctx.orgId}, ${ctx.locationId}, 'google',
        (now() at time zone (select timezone from locations where id = ${ctx.locationId}))::date,
        ${input.ratingBp}, ${input.reviewCount ?? 0}, now())
      on conflict (location_id, platform, on_date) do update set
        rating_bp = excluded.rating_bp, review_count = excluded.review_count, fetched_at = now()`;
    applied.push('rating');
  }
  audit({ entityType: 'location', entityId: ctx.locationId, after: { googlePlaceId: input.googlePlaceId, applied } });
  return { locationId: ctx.locationId, applied };
});
