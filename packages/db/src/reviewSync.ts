/**
 * 评价同步的跨租户待办枚举（05-AI-INTEGRATION §8）。
 *
 * ## 为什么需要一条特殊的读取路径
 *
 * 每日采集任务开始的时候不知道 org_id —— 它要回答的是「现在有哪些门店该同步了」。
 * 这和 Telnyx 通话对账用被叫号码反查门店是同一类问题：**缺的是一个上下文，
 * 不是权限**。因此这里不引入 service_role，也不给 apps/ 任何绕过 RLS 的连接
 * （宪法第 5 条），而是复用 0072 发票定位的做法：一个返回面极窄的
 * SECURITY DEFINER 函数。
 *
 * 它返回的字段只够开出租户上下文：org_id、location_id、平台、时区、语言。
 * 门店名称、地址、电话、评价内容一个字都不经过这条路径。拿到之后必须立刻
 * 改用 `withTenant` 开正常的租户事务去做真正的事。
 */

import { sql } from './client';

export interface ReviewSyncDue {
  orgId: string;
  locationId: string;
  platform: 'google' | 'yelp';
  timezone: string;
  locale: string;
  /**
   * `poll` = 已有一次进行中的采集，去取结果；
   * `start` = 该开新一轮了。
   *
   * ⚠️ 两者都必须处理。只处理 `start` 的话，一次已经付过费的抓取
   * 永远不会有人去下载，而唯一索引会让后续的触发全部失败 ——
   * 表现为「这家店的评价从某一天起再也不更新了」。
   */
  reason: 'poll' | 'start';
}

/**
 * 列出该同步的门店。
 *
 * @param staleMinutes 距上一次采集多久算「该同步了」。默认 12 小时。
 * @param limit 一轮最多处理几家。抓取要花钱，宁可分几轮也不要一次铺开。
 */
export async function listReviewSyncDue(args: {
  staleMinutes?: number;
  limit?: number;
} = {}): Promise<ReviewSyncDue[]> {
  const rows = await sql<{
    org_id: string; location_id: string; platform: string;
    timezone: string; locale: string; reason: string;
  }[]>`
    select * from gf_review_sync_due(
      ${args.staleMinutes ?? 720}::int, ${args.limit ?? 50}::int)`;

  return rows.map((r) => ({
    orgId: r.org_id,
    locationId: r.location_id,
    platform: r.platform === 'yelp' ? 'yelp' : 'google',
    timezone: r.timezone,
    locale: r.locale,
    reason: r.reason === 'poll' ? 'poll' : 'start',
  }));
}
