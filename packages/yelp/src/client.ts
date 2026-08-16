/**
 * Yelp Fusion 客户端 —— 薄薄一层 fetch，没有业务逻辑。
 *
 * 业务逻辑（字段映射、时区推断）全在 map.ts，那边是纯函数有测试。
 * 这里只负责：拼 URL、带 token、把失败翻成我们的错误码。
 *
 * ⚠️ **搜索是有配额的**（免费额度每天 500 次）。所以选定门店之后
 * `yelp_business_id` 要存进 `locations` —— 之后抓评价、刷营业时间都靠它，
 * 不用再搜一遍（05 §4.1）。
 */

import { AppError, ERROR_CODES } from '@gf/contracts';
import { mapBusiness, type MappedLocation, type YelpBusiness } from './map';

const BASE = 'https://api.yelp.com/v3';

export interface YelpClientOptions {
  apiKey: string;
  timeoutMs?: number;
  /** 注入用，测试里替换掉真实网络 */
  fetchImpl?: typeof fetch;
}

async function call<T>(path: string, opts: YelpClientOptions): Promise<T> {
  const f = opts.fetchImpl ?? fetch;
  const ac = new AbortController();
  // 老板正盯着屏幕等结果，八秒还没回来就该告诉他「搜不到，手工填吧」，
  // 而不是让他对着转圈继续等
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 8000);

  try {
    const res = await f(`${BASE}${path}`, {
      headers: { Authorization: `Bearer ${opts.apiKey}`, Accept: 'application/json' },
      signal: ac.signal,
    });

    if (res.status === 429) {
      // 配额用完了。这是「今天先手工填」而不是「系统坏了」，要分得开
      throw new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE, {
        details: { service: 'yelp', reason: 'rate_limited' },
      });
    }
    if (!res.ok) {
      throw new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE, {
        details: { service: 'yelp', status: res.status },
      });
    }
    return await res.json() as T;
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE, {
      details: { service: 'yelp', reason: e instanceof Error ? e.message : 'unknown' },
      cause: e,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 店名 + 邮编搜店。
 *
 * 命中多家时**全部返回让老板点一家**（带地址和评价数，一眼能认出自己的店），
 * 绝不替他挑第一个 —— 同一条街上两家「Lucky Nails」在美国太常见了，
 * 挑错了整家店的信息都是别人的。
 */
export async function searchBusinesses(
  args: { term: string; location: string; limit?: number },
  opts: YelpClientOptions,
): Promise<MappedLocation[]> {
  const q = new URLSearchParams({
    term: args.term,
    location: args.location,
    limit: String(Math.min(Math.max(args.limit ?? 8, 1), 20)),
  });
  const data = await call<{ businesses?: YelpBusiness[] }>(
    `/businesses/search?${q.toString()}`, opts);
  return (data.businesses ?? []).map(mapBusiness);
}

/**
 * 取一家店的详情。
 *
 * ⚠️ **营业时间只有这个接口有**，搜索结果里没有 —— 所以老板点选之后
 * 必须再拉一次详情，否则「一键填充」填不出营业时间，
 * 而那正是最省事的那一项。
 */
export async function getBusiness(
  businessId: string,
  opts: YelpClientOptions,
): Promise<MappedLocation> {
  const data = await call<YelpBusiness>(
    `/businesses/${encodeURIComponent(businessId)}`, opts);
  return mapBusiness(data);
}
