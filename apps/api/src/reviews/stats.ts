/**
 * 平台侧权威评分的每日刷新（05-AI-INTEGRATION §8.1）
 *
 * ## 为什么这条路和抓取分开
 *
 * 老板端「口碑趋势」那张图只依赖 `location_review_stats`，而这张表的数据来自
 * **官方接口**：Yelp Fusion 的 `/businesses/{id}` 与 Google Places 的详情。
 * 它们免费（或极便宜）、稳定、不会被反爬挡住。
 *
 * 抓取（Bright Data）负责的是评价**正文** —— 那条路会失败、会被限流、会花钱。
 * 两条路分开的结果是：抓取挂掉一周，老板照样能看到自己的分数在涨还是在跌。
 * 合成一条的话，一次反爬升级就会让口碑页面整体空白。
 *
 * 顺带把 Yelp Fusion 的 3 条截断评价也收进来：它免费，且在还没开抓取的门店里
 * 是唯一有正文的来源。⚠️ 每一条都以 `isExcerpt: true` 入库 —— 少了这个标记，
 * AI 摘要会对着被切掉的半句话下结论（05 §8.3）。
 */

import { getBusiness, getBusinessReviews, ratingToBp } from '@gf/yelp';
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

export async function refreshYelpStats(ctx: CommandContext): Promise<StatsRefreshOutcome> {
  const apiKey = process.env['YELP_API_KEY'];
  const { yelpBusinessId } = await sourceIds(ctx);
  if (!apiKey || !yelpBusinessId) {
    return { platform: 'yelp', state: 'skipped', ratingBp: null, reviewCount: null, excerptsIngested: 0, error: null };
  }

  try {
    const business = await getBusiness(yelpBusinessId, { apiKey });
    const ratingBp = ratingToBp(business.rating);
    await systemDispatch('reviews.recordStats', {
      platform: 'yelp', ratingBp, reviewCount: business.reviewCount,
    }, ctx);

    /*
     * 截断评价单独 try：拿不到它不该让已经成功的评分刷新变成失败。
     * 这两件事在同一次调用里，但重要性不同 —— 分数是趋势图的依据，
     * 3 条摘录只是锦上添花。
     */
    let excerptsIngested = 0;
    try {
      const excerpts = await getBusinessReviews(yelpBusinessId, { apiKey, locale: 'en_US' });
      if (excerpts.length > 0) {
        const out = await systemDispatch<{ inserted: number; updated: number }>('reviews.ingest', {
          platform: 'yelp', source: 'yelp_fusion', reviews: excerpts,
        }, ctx);
        excerptsIngested = out.result.inserted;
      }
    } catch { /* 见上：不影响评分刷新的成败 */ }

    return {
      platform: 'yelp', state: 'recorded',
      ratingBp, reviewCount: business.reviewCount, excerptsIngested, error: null,
    };
  } catch (e) {
    return {
      platform: 'yelp', state: 'failed', ratingBp: null, reviewCount: null, excerptsIngested: 0,
      error: e instanceof Error ? e.message : 'yelp_stats_failed',
    };
  }
}

export async function refreshGoogleStats(ctx: CommandContext): Promise<StatsRefreshOutcome> {
  const apiKey = process.env['GOOGLE_MAPS_API_KEY'];
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
