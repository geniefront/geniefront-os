import { describe, expect, it } from 'vitest';
import {
  extractPlatformStats, googleReviewsUrl, mapReview, mapReviews,
  normalizePostedAt, normalizeRating, yelpReviewsUrl,
} from './map';

describe('normalizeRating', () => {
  it('接受数字、字符串与带文案的星级', () => {
    expect(normalizeRating(4)).toBe(4);
    expect(normalizeRating('5')).toBe(5);
    expect(normalizeRating('4.0 star rating')).toBe(4);
  });

  it('拒绝越界值 —— 那通常意味着取到了评价总数', () => {
    expect(normalizeRating(0)).toBeNull();
    expect(normalizeRating(128)).toBeNull();
    expect(normalizeRating('n/a')).toBeNull();
    expect(normalizeRating(null)).toBeNull();
  });
});

describe('normalizePostedAt', () => {
  it('接受 ISO、纯日期与 Unix 时间戳', () => {
    expect(normalizePostedAt('2026-08-01T10:00:00Z')).toBe('2026-08-01T10:00:00.000Z');
    expect(normalizePostedAt('2026-08-01')).toBe('2026-08-01T00:00:00.000Z');
    expect(normalizePostedAt(1_754_006_400)).toBe(new Date(1_754_006_400_000).toISOString());
    expect(normalizePostedAt(1_754_006_400_000)).toBe(new Date(1_754_006_400_000).toISOString());
  });

  it('相对时间描述返回 null，不做换算', () => {
    expect(normalizePostedAt('3 months ago')).toBeNull();
    expect(normalizePostedAt('')).toBeNull();
  });
});

describe('mapReview', () => {
  it('兼容不同数据集版本的字段名', () => {
    const a = mapReview({
      review_id: 'g1', reviewer_name: 'Amy', review_text: '很好', review_rating: 5,
      review_datetime_utc: '2026-08-01T10:00:00Z', review_url: 'https://maps.example/g1',
    }, 'google');
    const b = mapReview({
      id: 'g1', author: 'Amy', text: '很好', stars: '5', date: '2026-08-01',
      link: 'https://maps.example/g1',
    }, 'google');

    expect(a?.externalId).toBe('g1');
    expect(a?.rating).toBe(5);
    expect(b?.externalId).toBe('g1');
    expect(b?.rating).toBe(5);
    expect(b?.authorName).toBe('Amy');
  });

  it('抓取来的正文是完整的，is_excerpt 恒为 false', () => {
    const review = mapReview({ review_id: 'g1', review_text: '完整正文', rating: 4 }, 'google');
    expect(review?.isExcerpt).toBe(false);
  });

  it('没有平台侧 id 的记录直接丢弃 —— 去重键不允许伪造', () => {
    expect(mapReview({ review_text: '好评', rating: 5 }, 'yelp')).toBeNull();
  });

  it('正文与评分俱空的记录不入库', () => {
    expect(mapReview({ review_id: 'y1', reviewer_name: 'Bob' }, 'yelp')).toBeNull();
  });
});

describe('mapReviews', () => {
  it('快照内部重复按 externalId 去掉，并计入 skipped', () => {
    const { reviews, skipped } = mapReviews([
      { review_id: 'a', review_text: '一', rating: 5 },
      { review_id: 'a', review_text: '一', rating: 5 },
      { review_text: '没有 id', rating: 5 },
    ], 'google');

    expect(reviews).toHaveLength(1);
    expect(skipped).toBe(2);
  });
});

describe('extractPlatformStats', () => {
  it('评分转成 basis point', () => {
    expect(extractPlatformStats([{ rating: 4.4, reviews_cnt: 218 }]))
      .toEqual({ ratingBp: 44_000, reviewCount: 218 });
  });

  it('取不到时返回 null，不猜一个默认值', () => {
    expect(extractPlatformStats([{ review_id: 'a' }]))
      .toEqual({ ratingBp: null, reviewCount: null });
  });
});

describe('抓取入参 URL', () => {
  it('优先用门店保存的 Maps URL', () => {
    expect(googleReviewsUrl({ mapsUrl: 'https://maps.app.goo.gl/abc', placeId: 'ChIJx' }))
      .toBe('https://maps.app.goo.gl/abc');
  });

  it('只有 place_id 时退化为官方跳转形式', () => {
    expect(googleReviewsUrl({ placeId: 'ChIJx' }))
      .toBe('https://www.google.com/maps/place/?q=place_id:ChIJx');
  });

  it('两者都没有则无法抓取', () => {
    expect(googleReviewsUrl({ mapsUrl: null, placeId: null })).toBeNull();
    expect(yelpReviewsUrl(null)).toBeNull();
  });

  it('Yelp business id 拼成 biz 页面', () => {
    expect(yelpReviewsUrl('lucky-nails-boston')).toBe('https://www.yelp.com/biz/lucky-nails-boston');
  });
});
