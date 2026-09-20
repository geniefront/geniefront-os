/** Google Places 评分刷新。Yelp 评分与正文统一由 Bright Data 快照写入。 */

import { withTenant } from '@gf/db';
import type { CommandContext } from '@gf/contracts';
import { getGooglePlace } from '../integrations/googlePlaces';
import { dispatch } from '../bus';
import '../handlers/reviews';

export interface StatsRefreshOutcome {
  platform: 'google' | 'yelp';
  /** 'skipped' = 没配标识或没有凭据，属于正常状态，不是故障 */
  state: 'recorded' | 'skipped' | 'failed';
  ratingBp: number | null;
  reviewCount: number | null;
  /** Fusion 顺带收到的截断评价条数（Google 侧恒为 0） */
  excerptsIngested: number;
  error: string | null;
}

const systemDispatch = <T>(command: string, input: unknown, ctx: CommandContext) =>
  dispatch<T>(command, input, ctx, { systemOrigin: 'review_platform_stats' });

async function sourceIds(ctx: CommandContext): Promise<{
  yelpBusinessId: string | null; googlePlaceId: string | null;
}> {
  const [row] = await withTenant(ctx, (tx) => tx<{
    yelp_business_id: string | null; google_place_id: string | null;
  }[]>`
    select yelp_business_id, google_place_id from locations where id = ${ctx.locationId}`);
  return {
    yelpBusinessId: row?.yelp_business_id ?? null,
    googlePlaceId: row?.google_place_id ?? null,
  };
}

export async function refreshGoogleStats(ctx: CommandContext): Promise<StatsRefreshOutcome> {
  const apiKey = process.env['GOOGLE_PLACES_API_KEY'] ?? process.env['GOOGLE_MAPS_API_KEY'];
  const { googlePlaceId } = await sourceIds(ctx);
  if (!apiKey || !googlePlaceId) {
    return { platform: 'google', state: 'skipped', ratingBp: null, reviewCount: null, excerptsIngested: 0, error: null };
  }

  try {
    const place = await getGooglePlace(googlePlaceId, apiKey);
    // 评分存 basis point（宪法第 4 条）：4.4 → 44000
    const ratingBp = place.rating === null ? null : Math.round(place.rating * 10_000);
    await systemDispatch('reviews.recordStats', {
      platform: 'google', ratingBp, reviewCount: place.reviewCount,
    }, ctx);
    return {
      platform: 'google', state: 'recorded',
      ratingBp, reviewCount: place.reviewCount, excerptsIngested: 0, error: null,
    };
  } catch (e) {
    return {
      platform: 'google', state: 'failed', ratingBp: null, reviewCount: null, excerptsIngested: 0,
      error: e instanceof Error ? e.message : 'google_stats_failed',
    };
  }
}
