/**
 * Yelp Fusion 的返回 → 我们的门店字段（05-AI-INTEGRATION §4.1）
 *
 * ⭐ **这一条路刻意不过模型。**
 *
 * `/businesses/search` 返回的本来就是结构化 JSON，让模型再读一遍纯属浪费 ——
 * 又贵、又慢、又多一处会出错的地方。老板输店名和邮编，我们直接映射。
 *
 * 但映射本身有三个坑，全在这个文件里，也全都有测试：
 *   1. **Yelp 的 day 0 是星期一**，不是星期天（`hours[].open[].day`）
 *   2. 跨午夜的营业时间（`is_overnight`）—— 足疗店开到凌晨两点是常态
 *   3. Yelp **不给时区**，只能从州推，而有九个州横跨两个时区
 *
 * 纯函数，无 IO。
 */

export interface YelpBusiness {
  id: string;
  name: string;
  phone?: string;
  display_phone?: string;
  rating?: number;
  review_count?: number;
  is_closed?: boolean;
  url?: string;
  location?: {
    address1?: string; address2?: string; address3?: string;
    city?: string; state?: string; zip_code?: string; country?: string;
    display_address?: string[];
  };
  coordinates?: { latitude?: number; longitude?: number };
  categories?: Array<{ alias: string; title: string }>;
  hours?: Array<{
    hours_type?: string;
    open?: Array<{ day: number; start: string; end: string; is_overnight?: boolean }>;
  }>;
}

export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

/**
 * ⚠️ Yelp 的 `day` 从**星期一 = 0** 开始数，不是 JS 的星期天 = 0。
 *
 * 照着 JS 的习惯写 `['sun','mon',...]` 的话，整张营业时间表会**整体错开一天**：
 * 周日的时间被填进周一。这种错不会报任何异常，只会让所有排班和
 * 「今天营不营业」的判断在真店里悄悄错一天 —— 而老板会以为是自己填错了。
 */
const YELP_DAY: readonly Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

/** "0930" → "09:30" */
function hhmm(v: string): string | null {
  if (!/^\d{4}$/.test(v)) return null;
  const h = Number(v.slice(0, 2));
  const m = Number(v.slice(2));
  if (h > 23 || m > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export type BusinessHours = Partial<Record<Weekday, { open: string; close: string } | null>>;

/**
 * 营业时间。
 *
 * 缺哪天就**不写那一天**（等价于不营业），而不是填一个默认值 ——
 * 猜一个「大概九点到七点」，老板不会注意到，然后系统在他休息的那天照常收预约。
 *
 * 一天有多段（中午休息）时取**最早开到最晚关**：我们的 `business_hours`
 * 一天只放一段。这是有意的简化，但要说清楚代价 —— 中午那两小时会被当成营业中。
 * 老板在确认页看得到，改一下就行；而支持多段要动整个排期口径，不值当在这里开。
 */
export function mapHours(biz: YelpBusiness): BusinessHours {
  const regular = biz.hours?.find((h) => h.hours_type === 'REGULAR') ?? biz.hours?.[0];
  const spans = regular?.open ?? [];
  const out: BusinessHours = {};

  for (const s of spans) {
    const key = YELP_DAY[s.day];
    if (!key) continue;
    const open = hhmm(s.start);
    const close = hhmm(s.end);
    if (!open || !close) continue;

    const prev = out[key];
    if (!prev) {
      out[key] = { open, close };
      continue;
    }
    // 一天多段：取最早开、最晚关。
    // 跨午夜那一段的 close（如 "02:00"）比谁都小，直接比字符串会把它当成最早，
    // 于是「开到凌晨两点」变成「凌晨两点关门」也就是开一小会儿 —— 反了。
    const prevCrosses = prev.close <= prev.open;
    const curCrosses = close <= open;
    out[key] = {
      open: open < prev.open ? open : prev.open,
      close: curCrosses ? close : (prevCrosses ? prev.close : (close > prev.close ? close : prev.close)),
    };
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 时区
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Yelp 不返回时区，只能从州推。
 *
 * 时区在这个系统里不是显示细节 —— `business_day_cutoff` 靠它算营业日，
 * 推错了整家店的日结、提成、报表全部错一天。所以推不准的一律标出来让老板确认，
 * 而不是静默填一个。
 */
const STATE_TZ: Record<string, string> = {
  AL: 'America/Chicago', AR: 'America/Chicago', AZ: 'America/Phoenix',
  CA: 'America/Los_Angeles', CO: 'America/Denver', CT: 'America/New_York',
  DC: 'America/New_York', DE: 'America/New_York', GA: 'America/New_York',
  IA: 'America/Chicago', IL: 'America/Chicago', LA: 'America/Chicago',
  MA: 'America/New_York', MD: 'America/New_York', ME: 'America/New_York',
  MN: 'America/Chicago', MO: 'America/Chicago', MS: 'America/Chicago',
  MT: 'America/Denver', NC: 'America/New_York', NH: 'America/New_York',
  NJ: 'America/New_York', NM: 'America/Denver', NV: 'America/Los_Angeles',
  NY: 'America/New_York', OH: 'America/New_York', OK: 'America/Chicago',
  PA: 'America/New_York', RI: 'America/New_York', SC: 'America/New_York',
  UT: 'America/Denver', VA: 'America/New_York', VT: 'America/New_York',
  WA: 'America/Los_Angeles', WI: 'America/Chicago', WV: 'America/New_York',
  WY: 'America/Denver',
  HI: 'Pacific/Honolulu', AK: 'America/Anchorage',
};

/**
 * 横跨两个时区的州。经度是个粗糙但够用的判据 ——
 * 这几个州的分界线大致就在这些经度上。
 */
const SPLIT_STATES: Record<string, { boundaryLon: number; west: string; east: string }> = {
  FL: { boundaryLon: -85.0, west: 'America/Chicago',     east: 'America/New_York' },
  IN: { boundaryLon: -86.9, west: 'America/Chicago',     east: 'America/New_York' },
  KY: { boundaryLon: -85.8, west: 'America/Chicago',     east: 'America/New_York' },
  MI: { boundaryLon: -87.5, west: 'America/Chicago',     east: 'America/New_York' },
  TN: { boundaryLon: -85.3, west: 'America/Chicago',     east: 'America/New_York' },
  TX: { boundaryLon: -105.0, west: 'America/Denver',     east: 'America/Chicago' },
  ND: { boundaryLon: -100.8, west: 'America/Denver',     east: 'America/Chicago' },
  SD: { boundaryLon: -100.0, west: 'America/Denver',     east: 'America/Chicago' },
  NE: { boundaryLon: -101.5, west: 'America/Denver',     east: 'America/Chicago' },
  KS: { boundaryLon: -101.5, west: 'America/Denver',     east: 'America/Chicago' },
  // 爱达荷/俄勒冈东部是山区时间。IANA 里另有 America/Boise，但它和 Denver
  // 的墙上时间完全一致 —— 返回两个同义时区只会让老板的选择列表里
  // 出现两个一模一样的「山区时间」按钮
  OR: { boundaryLon: -117.0, west: 'America/Los_Angeles', east: 'America/Denver' },
  ID: { boundaryLon: -116.0, west: 'America/Los_Angeles', east: 'America/Denver' },
};

export interface TimezoneGuess {
  timezone: string;
  /**
   * `high` = 全州一个时区，可以直接用。
   * `needs_confirm` = 跨时区的州（或者州都没有），确认页必须让老板看一眼 ——
   * 时区错了整家店的日结和提成都会错一天。
   */
  confidence: 'high' | 'needs_confirm';
}

export function guessTimezone(state?: string, longitude?: number): TimezoneGuess {
  const s = (state ?? '').trim().toUpperCase();

  const split = SPLIT_STATES[s];
  if (split) {
    // 经度都没有就更没把握了，但至少给个该州多数人用的
    if (typeof longitude !== 'number' || !Number.isFinite(longitude)) {
      return { timezone: split.east, confidence: 'needs_confirm' };
    }
    return {
      timezone: longitude < split.boundaryLon ? split.west : split.east,
      confidence: 'needs_confirm',
    };
  }

  const tz = STATE_TZ[s];
  if (tz) return { timezone: tz, confidence: 'high' };

  // 认不出的州（或者根本不在美国）—— 给一个最常见的，但一定要老板确认
  return { timezone: 'America/New_York', confidence: 'needs_confirm' };
}

// ─────────────────────────────────────────────────────────────────────────────
// 汇总
// ─────────────────────────────────────────────────────────────────────────────

export interface MappedLocation {
  yelpBusinessId: string;
  name: string;
  /** E.164。Yelp 给的 `phone` 已经是这个格式，`display_phone` 是给人看的 */
  phoneE164: string | null;
  displayPhone: string | null;
  address: {
    line1: string | null; line2: string | null;
    city: string | null; state: string | null; zip: string | null; country: string | null;
    display: string[];
  };
  timezone: string;
  timezoneConfidence: TimezoneGuess['confidence'];
  businessHours: BusinessHours;
  /** 权威评分。老板端的口碑趋势只依赖这个，不依赖抓取成不成功（05 §8.1） */
  rating: number | null;
  reviewCount: number | null;
  /** Yelp 上标了「已歇业」—— 多半是老板选错了那一家 */
  isClosed: boolean;
  categories: string[];
  yelpUrl: string | null;
}

export function mapBusiness(biz: YelpBusiness): MappedLocation {
  const loc = biz.location ?? {};
  const tz = guessTimezone(loc.state, biz.coordinates?.longitude);

  return {
    yelpBusinessId: biz.id,
    name: biz.name,
    // Yelp 偶尔给空字符串而不是省略。空字符串写进 phone 字段之后，
    // 「有没有电话」这个判断到处都会失灵
    phoneE164: nonEmpty(biz.phone),
    displayPhone: nonEmpty(biz.display_phone),
    address: {
      line1: nonEmpty(loc.address1),
      line2: [loc.address2, loc.address3].filter((v) => v && v.trim()).join(' ') || null,
      city: nonEmpty(loc.city),
      state: nonEmpty(loc.state),
      zip: nonEmpty(loc.zip_code),
      country: nonEmpty(loc.country),
      display: loc.display_address ?? [],
    },
    timezone: tz.timezone,
    timezoneConfidence: tz.confidence,
    businessHours: mapHours(biz),
    rating: typeof biz.rating === 'number' ? biz.rating : null,
    reviewCount: typeof biz.review_count === 'number' ? biz.review_count : null,
    isClosed: biz.is_closed === true,
    categories: (biz.categories ?? []).map((c) => c.title),
    yelpUrl: nonEmpty(biz.url),
  };
}

/** 评分存成 basis point：4.3 → 43000（宪法第 4 条，百分比与小数一律整数） */
export function ratingToBp(rating: number | null): number | null {
  if (rating === null || !Number.isFinite(rating)) return null;
  return Math.round(rating * 10000);
}

const nonEmpty = (v: string | undefined): string | null =>
  typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
