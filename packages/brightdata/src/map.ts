/**
 * Bright Data 快照记录 → 标准化评价（05-AI-INTEGRATION §8.1）
 *
 * 纯函数，无 IO，全部有测试。
 *
 * ## 为什么要做字段别名兼容
 *
 * Bright Data 的数据集字段名由数据集版本决定，同一个「评价正文」在不同版本里
 * 可能叫 `review_text`、`review`、`text` 或 `comment`。抓取侧的字段改名不会
 * 报错，只会让正文变成 null —— 而 null 正文在下游表现为「这家店最近没人写评价」，
 * 属于典型的静默失败。因此这里对每个业务字段声明一组候选键，
 * 取第一个非空值，并在全部落空时由调用方按「跳过该条」处理。
 *
 * ## external_id 的地位
 *
 * `location_reviews` 的去重唯一键是 (location_id, platform, external_id)。
 * 抓不到平台侧稳定 id 的记录一律丢弃，不允许退化成「用正文哈希凑一个」：
 * 平台修改过错别字的评价会因此产生第二行，口碑统计随之重复计数。
 */

/** 平台原始记录：字段名不稳定，故按 unknown 处理后逐一取值 */
export type BrightDataRecord = Record<string, unknown>;

export type ReviewPlatform = 'google' | 'yelp';

export interface NormalizedReview {
  platform: ReviewPlatform;
  /** 平台侧稳定标识，去重唯一键的一部分 */
  externalId: string;
  /** 1–5。平台给不出评分时为 null，不猜测 */
  rating: number | null;
  authorName: string | null;
  content: string | null;
  /**
   * 正文是否被平台截断。Bright Data 抓的是完整正文，因此恒为 false；
   * 该字段保留是为了与 Yelp Fusion 走同一条入库路径（reviews.ts 表注释）。
   */
  isExcerpt: boolean;
  url: string | null;
  /** ISO 字符串。解析不出合法时间时为 null，由入库侧回退到抓取时间 */
  postedAt: string | null;
}

function pick(record: BrightDataRecord, keys: readonly string[]): unknown {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function asText(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/**
 * 评分归一化。
 *
 * 平台可能返回数字 4、字符串 "4"、或 "4.0 star rating" 这类带文案的形式。
 * 取整而非四舍五入到小数：`location_reviews.rating` 是 integer，
 * 单条评价在两个平台上都只能是整数星级。超出 1–5 的一律判为无效，
 * 因为那通常意味着字段取错（例如取到了 `reviews_cnt`）。
 */
export function normalizeRating(value: unknown): number | null {
  let raw: number | null = null;
  if (typeof value === 'number') raw = value;
  else if (typeof value === 'string') {
    const matched = /-?\d+(\.\d+)?/.exec(value);
    if (matched) raw = Number(matched[0]);
  }
  if (raw === null || !Number.isFinite(raw)) return null;
  const rounded = Math.round(raw);
  return rounded >= 1 && rounded <= 5 ? rounded : null;
}

/**
 * 时间归一化。
 *
 * Bright Data 对 Google 给的是 ISO 时间戳，对 Yelp 有时给 `YYYY-MM-DD`，
 * 也出现过 Unix 毫秒数。三种都接，其余（"3 个月前" 这类相对描述）一律返回 null：
 * 把相对描述换算成绝对时间需要知道抓取时刻，在这个纯函数里没有可靠依据，
 * 猜一个会让「最近 30 天口碑」这类查询产生看不出来的偏差。
 */
export function normalizePostedAt(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // 秒级时间戳（10 位）与毫秒级（13 位）都出现过
    const ms = value > 1e11 ? value : value * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text.length === 0) return null;
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T00:00:00Z` : text);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

const ID_KEYS = ['review_id', 'reviewId', 'id', 'review_uuid'] as const;
const AUTHOR_KEYS = ['reviewer_name', 'author_name', 'user_name', 'author', 'name'] as const;
const CONTENT_KEYS = ['review_text', 'review', 'text', 'comment', 'snippet', 'body'] as const;
const RATING_KEYS = ['review_rating', 'rating', 'stars', 'star_rating', 'score'] as const;
const URL_KEYS = ['review_url', 'url', 'link', 'review_link'] as const;
const POSTED_KEYS = [
  'review_datetime_utc', 'review_date', 'date', 'created_at', 'time', 'review_timestamp',
] as const;

/**
 * 单条记录归一化。返回 null 表示该条不可用（缺少稳定 id 或正文与评分俱空），
 * 调用方计入 `skipped` 而不是写库。
 */
export function mapReview(
  record: BrightDataRecord,
  platform: ReviewPlatform,
): NormalizedReview | null {
  const externalId = asText(pick(record, ID_KEYS));
  if (!externalId) return null;

  const content = asText(pick(record, CONTENT_KEYS));
  const rating = normalizeRating(pick(record, RATING_KEYS));
  // 既没有正文也没有星级的记录对下游（统计与摘要）没有任何贡献，
  // 写进去只会让 review_count 虚高
  if (content === null && rating === null) return null;

  return {
    platform,
    externalId,
    rating,
    authorName: asText(pick(record, AUTHOR_KEYS)),
    content,
    isExcerpt: false,
    url: asText(pick(record, URL_KEYS)),
    postedAt: normalizePostedAt(pick(record, POSTED_KEYS)),
  };
}

/**
 * 整份快照归一化，并按 externalId 去重。
 *
 * 快照内部就可能出现重复（分页边界重叠）。在这里去掉，
 * 而不是依赖数据库唯一索引报冲突 —— 后者会把一次正常的抓取变成一串错误日志。
 */
export function mapReviews(
  records: readonly BrightDataRecord[],
  platform: ReviewPlatform,
): { reviews: NormalizedReview[]; skipped: number } {
  const seen = new Set<string>();
  const reviews: NormalizedReview[] = [];
  let skipped = 0;

  for (const record of records) {
    const mapped = mapReview(record, platform);
    if (!mapped) { skipped++; continue; }
    if (seen.has(mapped.externalId)) { skipped++; continue; }
    seen.add(mapped.externalId);
    reviews.push(mapped);
  }
  return { reviews, skipped };
}

/**
 * 快照里附带的平台侧汇总（总评分与评价总数）。
 *
 * ⚠️ 仅作为兜底。`location_review_stats` 的权威来源是 Yelp Fusion 与
 * Google Places 的详情接口（05 §8.1）—— 它们免费、稳定，且不依赖抓取是否成功。
 * 抓取结果里的汇总用于抓取成功但详情接口不可用的场合。
 */
export function extractPlatformStats(
  records: readonly BrightDataRecord[],
): { ratingBp: number | null; reviewCount: number | null } {
  for (const record of records) {
    const rating = pick(record, ['rating', 'overall_rating', 'business_rating']);
    const count = pick(record, ['reviews_cnt', 'review_count', 'reviews_count', 'total_reviews']);
    const ratingNum = typeof rating === 'number' ? rating : Number(asText(rating) ?? NaN);
    const countNum = typeof count === 'number' ? count : Number(asText(count) ?? NaN);
    if (Number.isFinite(ratingNum) && ratingNum > 0 && ratingNum <= 5) {
      return {
        // 评分存 basis point（宪法第 4 条）：4.4 → 44000
        ratingBp: Math.round(ratingNum * 10000),
        reviewCount: Number.isFinite(countNum) ? Math.max(0, Math.round(countNum)) : null,
      };
    }
  }
  return { ratingBp: null, reviewCount: null };
}

/**
 * Google Maps 抓取入参 URL。
 *
 * 优先使用门店保存的 Maps URL；只有 place_id 时退化为官方的
 * `?q=place_id:` 形式 —— 它会 302 到真实的门店页，抓取器跟随跳转即可。
 */
export function googleReviewsUrl(args: {
  mapsUrl?: string | null;
  placeId?: string | null;
}): string | null {
  const url = args.mapsUrl?.trim();
  if (url) return url;
  const placeId = args.placeId?.trim();
  if (!placeId) return null;
  return `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(placeId)}`;
}

/** Yelp 抓取入参 URL。business id 就是 biz 页面的 slug。 */
export function yelpReviewsUrl(businessId: string | null | undefined): string | null {
  const id = businessId?.trim();
  if (!id) return null;
  return `https://www.yelp.com/biz/${encodeURIComponent(id)}`;
}
