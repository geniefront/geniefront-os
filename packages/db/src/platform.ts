/**
 * Platform operator helpers.
 *
 * Runtime still uses app_user + withUser(). Cross-tenant reads go through
 * the narrow SECURITY DEFINER functions in sql/0074, which re-check
 * platform_operators against app.user_id inside the database.
 */

import type postgres from 'postgres';
import { withUser } from './client';

export const PLATFORM_OPS_USER_ID = '33333333-3333-4333-8333-333333333333';
export const PLATFORM_EXOPS_USER_ID = '44444444-4444-4444-8444-444444444444';

export type PlatformOperatorRole = 'super_admin' | 'support';

export async function platformOperatorRole(userId: string): Promise<PlatformOperatorRole | null> {
  const [row] = await withUser(userId, (tx) =>
    tx<{ role: string | null }[]>`select gf_platform_operator_role() as role`);
  const role = row?.role;
  return role === 'super_admin' || role === 'support' ? role : null;
}

async function callJson<T>(
  userId: string,
  fn: (tx: postgres.TransactionSql) => Promise<{ data: T }[]>,
): Promise<T> {
  const [row] = await withUser(userId, fn);
  return row!.data;
}

export async function platformDashboardCounts(userId: string): Promise<unknown> {
  return callJson(userId, (tx) =>
    tx<{ data: unknown }[]>`select gf_platform_dashboard_counts() as data`);
}

export async function platformSearchStores(
  userId: string,
  query: string,
  limit = 50,
  offset = 0,
): Promise<unknown> {
  return callJson(userId, (tx) =>
    tx<{ data: unknown }[]>`
      select gf_platform_search_stores(${query}, ${limit}::int, ${offset}::int) as data`);
}

export async function platformStoreDetail(userId: string, locationId: string): Promise<unknown> {
  return callJson(userId, (tx) =>
    tx<{ data: unknown }[]>`select gf_platform_store_detail(${locationId}::uuid) as data`);
}

/**
 * 这家店的外发消息卡在哪一道闸门（sql/0089）。
 *
 * 与 `platformStoreDetail` 分开是有意的：那一份是两百行的聚合，为两个字段
 * 去改它等于把整份函数体重抄一遍，抄错一个列名不会报错、只会让运营台上
 * 某一块静默变空。
 */
export async function platformMessagingPanel(
  userId: string, locationId: string,
): Promise<unknown> {
  return callJson(userId, (tx) =>
    tx<{ data: unknown }[]>`select gf_platform_messaging_panel(${locationId}::uuid) as data`);
}

export async function platformListSupportRequests(
  userId: string,
  status: string | null,
  limit = 50,
  offset = 0,
): Promise<unknown> {
  return callJson(userId, (tx) =>
    tx<{ data: unknown }[]>`
      select gf_platform_list_support_requests(${status}, ${limit}::int, ${offset}::int) as data`);
}

export async function platformSupportRequestDetail(userId: string, id: string): Promise<unknown> {
  return callJson(userId, (tx) =>
    tx<{ data: unknown }[]>`select gf_platform_support_request_detail(${id}::uuid) as data`);
}

export async function platformList10Dlc(
  userId: string,
  status: string | null,
  limit = 50,
  offset = 0,
): Promise<unknown> {
  return callJson(userId, (tx) =>
    tx<{ data: unknown }[]>`
      select gf_platform_list_10dlc(${status}, ${limit}::int, ${offset}::int) as data`);
}

export async function platform10DlcDetail(userId: string, locationId: string): Promise<unknown> {
  return callJson(userId, (tx) =>
    tx<{ data: unknown }[]>`select gf_platform_10dlc_detail(${locationId}::uuid) as data`);
}

export async function platformListStorefrontRequests(
  userId: string,
  limit = 50,
  offset = 0,
): Promise<unknown> {
  return callJson(userId, (tx) =>
    tx<{ data: unknown }[]>`
      select gf_platform_list_storefront_requests(${limit}::int, ${offset}::int) as data`);
}

export async function platformStorefrontDetail(userId: string, briefId: string): Promise<unknown> {
  return callJson(userId, (tx) =>
    tx<{ data: unknown }[]>`select gf_platform_storefront_detail(${briefId}::uuid) as data`);
}

export async function platformListAudit(
  userId: string,
  args: {
    locationId?: string | null;
    command?: string | null;
    actorId?: string | null;
    from?: string | null;
    to?: string | null;
    limit?: number;
    offset?: number;
  },
): Promise<unknown> {
  const limit = args.limit ?? 50;
  const offset = args.offset ?? 0;
  return callJson(userId, (tx) =>
    tx<{ data: unknown }[]>`
      select gf_platform_list_audit(
        ${args.locationId ?? null}::uuid,
        ${args.command ?? null},
        ${args.actorId ?? null}::uuid,
        ${args.from ?? null}::timestamptz,
        ${args.to ?? null}::timestamptz,
        ${limit}::int,
        ${offset}::int
      ) as data`);
}

/**
 * 测试收件箱（sql/0082）。
 *
 * capture 模式下发出去的邮件与短信留在原来的发件箱里，这里跨租户读出来 ——
 * 运营的人要看的是「刚才那笔单发了什么」，而那笔单在哪家店他不一定知道。
 */
export async function platformTestInbox(
  userId: string,
  args: {
    channel?: string | null;
    status?: string | null;
    search?: string | null;
    limit?: number;
    offset?: number;
  },
): Promise<unknown> {
  const limit = args.limit ?? 50;
  const offset = args.offset ?? 0;
  return callJson(userId, (tx) =>
    tx<{ data: unknown }[]>`
      select gf_platform_test_inbox(
        ${args.channel ?? null},
        ${args.status ?? null},
        ${args.search ?? null},
        ${limit}::int,
        ${offset}::int
      ) as data`);
}

/** 单封详情：完整正文（邮件含 HTML）与抽出来的链接。 */
export async function platformTestMessage(
  userId: string,
  channel: 'email' | 'sms',
  id: string,
): Promise<unknown> {
  return callJson(userId, (tx) =>
    tx<{ data: unknown }[]>`
      select gf_platform_test_message(${channel}, ${id}::uuid) as data`);
}
