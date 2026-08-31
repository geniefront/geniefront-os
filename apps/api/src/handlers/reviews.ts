/**
 * 外部评价采集与 AI 口碑分析的命令处理器（05-AI-INTEGRATION §8）
 *
 * 这里是整条采集链路上**唯一**写库的地方。编排代码（apps/api/src/reviews/）
 * 只负责调外部接口和决定下一步，写入一律回到这几条命令上 ——
 * 于是审计、租户事务、欠费冻结不可能因为「这是后台任务」被绕过。
 */

import {
  AttachSyncSnapshot, ConfigureReviewSources, FinishReviewSyncRun, IngestReviews, RecordReviewStats,
  SaveReviewAnalysis, SaveReviewSummary, StartReviewSyncRun,
} from '@gf/contracts';
import { jsonb } from '@gf/db';
import { registerHandler, type HandlerArgs } from '../bus';

// ─────────────────────────────────────────────────────────────────────────────
// 采集配置
// ─────────────────────────────────────────────────────────────────────────────

registerHandler(ConfigureReviewSources, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof ConfigureReviewSources.input._type>) => {
  const configured: string[] = [];
  if (input.googlePlaceId !== undefined) configured.push('googlePlaceId');
  if (input.googleMapsUrl !== undefined) configured.push('googleMapsUrl');
  if (input.yelpBusinessId !== undefined) configured.push('yelpBusinessId');

  const [before] = await tx<{
    google_place_id: string | null; google_maps_url: string | null; yelp_business_id: string | null;
  }[]>`
    select google_place_id, google_maps_url, yelp_business_id
    from locations where id = ${ctx.locationId}`;

  /*
   * ⚠️ 「不传」和「传 null」是两件事。
   *
   * 不传 = 不动这一项；传 null = 明确要求清空。用 coalesce 一把梭的话
   * 后者会退化成前者 —— 老板想停掉 Google 抓取，点了保存，配置纹丝不动，
   * 而抓取第二天照常发生并照常计费。
   */
  await tx`
    update locations set
      google_place_id = ${input.googlePlaceId === undefined
        ? tx`google_place_id` : input.googlePlaceId},
      google_maps_url = ${input.googleMapsUrl === undefined
        ? tx`google_maps_url` : input.googleMapsUrl},
      yelp_business_id = ${input.yelpBusinessId === undefined
        ? tx`yelp_business_id` : input.yelpBusinessId}
    where id = ${ctx.locationId}`;

  audit({
    entityType: 'location', entityId: ctx.locationId,
    before: {
      googlePlaceId: before?.google_place_id ?? null,
      googleMapsUrl: before?.google_maps_url ?? null,
      yelpBusinessId: before?.yelp_business_id ?? null,
    },
    after: { configured },
  });

  return { locationId: ctx.locationId, configured };
});

// ─────────────────────────────────────────────────────────────────────────────
// 同步运行记录
// ─────────────────────────────────────────────────────────────────────────────

registerHandler(StartReviewSyncRun, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof StartReviewSyncRun.input._type>) => {
  const [row] = await tx<{ id: string }[]>`
    insert into review_sync_runs
      (org_id, location_id, platform, source, status, snapshot_id, attempts, meta)
    values (${ctx.orgId}, ${ctx.locationId}, ${input.platform}, ${input.source},
            'running', ${input.snapshotId ?? null}, 1, ${jsonb(input.meta ?? {})}::jsonb)
    returning id`;

  // 采集是要花钱的动作，谁在什么时候开了一轮必须留痕
  audit({
    entityType: 'review_sync_run', entityId: row!.id,
    after: { platform: input.platform, source: input.source },
  });

  return { runId: row!.id };
});

registerHandler(AttachSyncSnapshot, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof AttachSyncSnapshot.input._type>) => {
  await tx`
    update review_sync_runs set snapshot_id = ${input.snapshotId}
    where id = ${input.runId} and location_id = ${ctx.locationId}`;

  // ⛔ 审计里不写 snapshotId 本身：拿到它的人可以直接向 Bright Data
  // 拉走这次抓取的全部结果。只留「拿到了」这个事实
  audit({
    entityType: 'review_sync_run', entityId: input.runId,
    after: { snapshotAttached: true },
  });

  return { runId: input.runId };
});

registerHandler(FinishReviewSyncRun, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof FinishReviewSyncRun.input._type>) => {
  const [row] = await tx<{ id: string; status: string }[]>`
    update review_sync_runs set
      status = ${input.status},
      attempts = attempts + 1,
      finished_at = now(),
      fetched_count = ${input.fetchedCount},
      inserted_count = ${input.insertedCount},
      skipped_count = ${input.skippedCount},
      cost_millicents = ${input.costMillicents},
      error = ${input.error ?? null}
    where id = ${input.runId} and location_id = ${ctx.locationId}
    returning id, status`;

  audit({
    entityType: 'review_sync_run', entityId: input.runId,
    after: {
      status: input.status,
      fetched: input.fetchedCount,
      inserted: input.insertedCount,
      costMillicents: input.costMillicents,
      error: input.error ?? null,
    },
  });

  // 找不到行 = 这次运行不属于本店。返回原样的 runId 而不是抛错：
  // 收尾失败不该把一次成功的抓取变成「彻底失败」，日志里查得到
  return { runId: row?.id ?? input.runId, status: row?.status ?? 'unknown' };
});

// ─────────────────────────────────────────────────────────────────────────────
// 评价正文
// ─────────────────────────────────────────────────────────────────────────────

registerHandler(IngestReviews, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof IngestReviews.input._type>) => {
  let inserted = 0;
  let updated = 0;

  for (const review of input.reviews) {
    /*
     * 冲突时**只补正文、评分与链接**。
     *
     * ⛔ 不碰 `status`、`ai_sentiment`、`ai_highlights` 和人工关联的
     * 技师/服务/工单：一条已经回复过、已经关联到具体技师的差评，
     * 不该因为第二天又被抓到一次就退回「未处理」并丢掉分析结果。
     *
     * `xmax = 0` 是 Postgres 里区分「这一行是新插的还是更新的」的标准写法：
     * 更新走的是 UPDATE 路径，xmax 非零。没有它就只能报一个合计数，
     * 而「今天新增了几条」正是同步日志里最有用的那个数字。
     */
    const [row] = await tx<{ was_insert: boolean }[]>`
      insert into location_reviews
        (org_id, location_id, platform, source, external_id, rating, author_name,
         content, is_excerpt, url, posted_at, scraped_at)
      values (${ctx.orgId}, ${ctx.locationId}, ${input.platform}, ${input.source},
              ${review.externalId}, ${review.rating}, ${review.authorName},
              ${review.content}, ${review.isExcerpt}, ${review.url},
              ${review.postedAt}::timestamptz, now())
      on conflict (location_id, platform, external_id) do update set
        rating = excluded.rating,
        author_name = coalesce(excluded.author_name, location_reviews.author_name),
        content = coalesce(excluded.content, location_reviews.content),
        is_excerpt = excluded.is_excerpt,
        url = coalesce(excluded.url, location_reviews.url),
        posted_at = coalesce(excluded.posted_at, location_reviews.posted_at),
        source = excluded.source
      returning (xmax = 0) as was_insert`;

    if (row?.was_insert) inserted++; else updated++;
  }

  /*
   * 审计只记条数，不记正文与作者名。
   *
   * 评价是公开内容，但审计日志的用途是「谁在什么时候动了什么」，
   * 把几十条正文复制进去只会让这张表膨胀，且对排查没有任何帮助。
   */
  audit({
    entityType: 'location', entityId: ctx.locationId,
    after: { platform: input.platform, source: input.source, inserted, updated },
  });

  return { inserted, updated };
});

registerHandler(RecordReviewStats, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof RecordReviewStats.input._type>) => {
  /*
   * ⚠️ 唯一键是 (location, platform, on_date) —— 这张表是**按天**留一行的，
   * 老板端的口碑趋势图靠的就是这一串历史点。冲突键写成 (location, platform)
   * 会让每天的分数互相覆盖，趋势图上永远只有一个点。
   *
   * 日期取门店本地日期：跨时区的连锁店按 UTC 记会在午夜前后错开一天。
   */
  const [row] = await tx<{ on_date: string }[]>`
    insert into location_review_stats
      (org_id, location_id, platform, on_date, rating_bp, review_count, fetched_at)
    values (${ctx.orgId}, ${ctx.locationId}, ${input.platform},
            (now() at time zone (select timezone from locations where id = ${ctx.locationId}))::date,
            ${input.ratingBp}, ${input.reviewCount ?? 0}, now())
    on conflict (location_id, platform, on_date) do update set
      rating_bp = excluded.rating_bp,
      review_count = excluded.review_count,
      fetched_at = excluded.fetched_at
    returning on_date::text as on_date`;

  audit({
    entityType: 'location', entityId: ctx.locationId,
    after: {
      platform: input.platform, onDate: row!.on_date,
      ratingBp: input.ratingBp, reviewCount: input.reviewCount,
    },
  });

  return { platform: input.platform, onDate: row!.on_date };
});

// ─────────────────────────────────────────────────────────────────────────────
// 模型产出
// ─────────────────────────────────────────────────────────────────────────────

registerHandler(SaveReviewAnalysis, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof SaveReviewAnalysis.input._type>) => {
  let updated = 0;
  for (const item of input.items) {
    const rows = await tx`
      update location_reviews set
        ai_sentiment = ${item.sentiment},
        ai_highlights = ${jsonb(item.highlights)}::jsonb
      where id = ${item.reviewId} and location_id = ${ctx.locationId}`;
    updated += rows.count;
  }

  // 只记条数与模型标签的分布 —— 要点原文在评价行上查得到，
  // 复制进审计日志只会让这张表膨胀
  audit({
    entityType: 'location', entityId: ctx.locationId,
    after: { analyzed: input.items.length, updated },
  });

  return { updated };
});

registerHandler(SaveReviewSummary, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof SaveReviewSummary.input._type>) => {
  const [row] = await tx<{ id: string; generated_at: string }[]>`
    insert into review_summaries
      (org_id, location_id, period_start, period_end, coverage, latest_review_id,
       summary_content, excerpt_ratio_bp, generated_at, token_cost_cents)
    values (${ctx.orgId}, ${ctx.locationId},
            ${input.periodStart}::date, ${input.periodEnd}::date,
            ${jsonb(input.coverage)}::jsonb, ${input.latestReviewId},
            ${jsonb(input.content)}::jsonb, ${input.excerptRatioBp}, now(),
            ${input.tokenCostCents})
    returning id, generated_at::text as generated_at`;

  audit({
    entityType: 'review_summary', entityId: row!.id,
    after: {
      periodStart: input.periodStart, periodEnd: input.periodEnd,
      coverage: input.coverage, excerptRatioBp: input.excerptRatioBp,
      confidence: input.content.confidence,
    },
  });

  return { summaryId: row!.id, generatedAt: row!.generated_at };
});
