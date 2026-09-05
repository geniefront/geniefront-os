/**
 * 营销四事件的调度器（sql/0092）。
 *
 * 批 7 定了事件键、建了模板表与规则表，`offset_min` 也存了值 —— 但**全仓
 * 没有任何代码读它们**。这四条因此从来没发过，而设置页上那几个开关看起来
 * 是好的。本文件把它们接上。
 *
 * ## ⚠️ 接上不等于会发出去
 *
 * 每一条仍要过完 `notifyEvent` 里那几道闸门，缺一不可：
 *
 *   1. 门店在通知设置里打开了这个事件的渠道（规则默认关闭）；
 *   2. 这位顾客**明示订阅**过营销（`marketing_sms_opt_in` /
 *      `marketing_email_opt_in`）；
 *   3. 短信：门店自己的 10DLC 已 `approved`（`sms/gate.ts`）；
 *   4. 邮件：门店专属发件域名已在 SES 验证（`locations.marketing_email_from`）；
 *   5. 短信还要落在门店本地 08:00–21:00 之内（TCPA，`sms/flush.ts`）。
 *
 * 也就是说，把这个调度器接上**不会**让任何一家店突然开始发营销 ——
 * 这是有意的。
 *
 * ## 去重靠发件箱的唯一索引，不建新表
 *
 * `(entity_type, entity_id, kind)` 上有唯一索引。周期被编进 `entity_type`
 * （`birthday_2026`、`winback_2026-09`…），于是「一年一封」「一月一封」
 * 是数据库保证的，不是这里的 if 判断保证的（口径见 sql/0092）。
 */

import type { FastifyInstance } from 'fastify';
import { sql, withTenant } from '@gf/db';
import type { CommandContext, NotificationEvent } from '@gf/contracts';
import { pickText } from '@gf/contracts';
import { notifyEvent } from './dispatch';
import { flushSms } from '../sms/flush';
import { flushEmails } from '../email/flush';

/** 门店本地时间过了这个点才发。太早发营销短信是骚扰。 */
const DEFAULT_SEND_HOUR = 10;
/** 多久没来算「该唤回」。 */
const DEFAULT_WINBACK_DAYS = 90;
/** 结账之后隔多久再问评价。 */
const DEFAULT_REVIEW_DELAY_HOURS = 3;
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;

interface Candidate {
  org_id: string;
  location_id: string;
  customer_id: string;
  /** 编进 `entity_type` 的周期串，去重靠它 */
  period?: string;
  holiday_name?: string;
  days_since?: number;
  ticket_id?: string;
}

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0];

function systemContext(orgId: string, locationId: string, timezone: string): CommandContext {
  /*
   * `membershipId: null` —— 定时任务背后没有人。硬塞一个真实 membership
   * 会让审计流水指向某位前台，而她什么都没做过。
   */
  return {
    orgId,
    locationId,
    userId: '00000000-0000-4000-8000-000000000000',
    membershipId: null,
    permissions: new Set<string>(),
    actorKind: 'api',
    locale: 'en',
    timezone,
  } as unknown as CommandContext;
}

/**
 * 门店的公用变量：店名、电话、评价链接。
 *
 * ⚠️ 一律按 `'en'` 取 —— 顾客侧的邮件与短信恒为英语
 * （`email/render.ts` 文件头），而同一组变量会同时喂给两个渠道。
 */
async function shopVars(tx: Tx, locationId: string): Promise<{
  shop_name: string; shop_phone: string; review_url: string; timezone: string;
}> {
  const [loc] = await tx<{
    name: unknown; timezone: string;
    google_maps_url: string | null; google_place_id: string | null;
  }[]>`
    select name, timezone, google_maps_url, google_place_id
    from locations where id = ${locationId}`;
  const [line] = await tx<{ e164: string }[]>`
    select e164 from phone_lines
    where location_id = ${locationId} and purpose = 'main' and active limit 1`;

  /*
   * 评价链接优先用店主自己贴的那条短链（0084 的 `google_maps_url`）——
   * 由 place_id 拼出的官方形式虽然可用，但店主从浏览器里复制来的那条
   * 更短、也更像他自己发的。
   */
  const reviewUrl = loc?.google_maps_url
    ?? (loc?.google_place_id
      ? `https://search.google.com/local/writereview?placeid=${loc.google_place_id}`
      : '');

  return {
    shop_name: pickText(loc?.name, 'en', ''),
    shop_phone: line?.e164 ?? '',
    review_url: reviewUrl,
    timezone: loc?.timezone ?? 'UTC',
  };
}

async function enqueueBatch(
  app: Pick<FastifyInstance, 'log'>,
  event: NotificationEvent,
  rows: Candidate[],
  extraVars: (c: Candidate) => Record<string, string>,
  entityTypeOf: (c: Candidate) => string,
  entityIdOf: (c: Candidate) => string,
): Promise<number> {
  const byLocation = new Map<string, Candidate[]>();
  for (const r of rows) {
    const list = byLocation.get(r.location_id);
    if (list) list.push(r);
    else byLocation.set(r.location_id, [r]);
  }

  let queued = 0;
  for (const [locationId, list] of byLocation) {
    const tenant = { orgId: list[0]!.org_id, locationId, membershipId: null };
    try {
      queued += await withTenant(tenant, async (tx) => {
        const shop = await shopVars(tx, locationId);
        const ctx = systemContext(tenant.orgId, locationId, shop.timezone);
        let n = 0;
        for (const c of list) {
          const [cust] = await tx<{
            name: unknown; email: string | null; phone: string | null;
          }[]>`
            select display_name as name, email, phone_e164 as phone
            from customers where id = ${c.customer_id}`;
          if (!cust) continue;

          n += await notifyEvent(tx, ctx, {
            event,
            entityType: entityTypeOf(c),
            entityId: entityIdOf(c),
            vars: {
              customer_name: pickText(cust.name, 'en', ''),
              shop_name: shop.shop_name,
              shop_phone: shop.shop_phone,
              review_url: shop.review_url,
              ...extraVars(c),
            },
            toEmail: cust.email,
            toPhone: cust.phone,
            // ⚠️ 营销必须带 customerId：订阅校验与退订令牌都要它
            customerId: c.customer_id,
            locale: 'en',
          });
        }
        return n;
      });

      /*
       * ⚠️ 投递在事务之外。事务里发的话，回滚之后顾客已经收到一条推广，
       * 而发件箱里没有那一行。
       */
      void flushSms(tenant, app.log as never);
      void flushEmails(tenant, app.log as never);
    } catch (e) {
      // 一家店失败不该拖垮整轮。下一轮会重新取到（尚未入队即未去重）
      app.log.warn({ err: e, locationId, event }, 'marketing sweep: 该门店本轮失败');
    }
  }
  return queued;
}

export interface MarketingSweepResult {
  birthday: number; holiday: number; winback: number; reviewRequest: number;
}

export async function runMarketingSweep(
  app: Pick<FastifyInstance, 'log'>,
  opts: {
    sendHour?: number; winbackDays?: number; reviewDelayHours?: number;
  } = {},
): Promise<MarketingSweepResult> {
  return { birthday: 0, holiday: 0, winback: 0, reviewRequest: 0 };
  const hour = opts.sendHour ?? DEFAULT_SEND_HOUR;
  const winbackDays = opts.winbackDays ?? DEFAULT_WINBACK_DAYS;
  const reviewDelay = opts.reviewDelayHours ?? DEFAULT_REVIEW_DELAY_HOURS;

  const [birthdays, holidays, winbacks, reviews] = await Promise.all([
    sql<Candidate[]>`select * from gf_marketing_birthdays_due(${hour}, 200)`,
    sql<Candidate[]>`select * from gf_marketing_holidays_due(${hour}, 500)`,
    sql<Candidate[]>`select * from gf_marketing_winback_due(${winbackDays}, ${hour}, 200)`,
    sql<Candidate[]>`
      select * from gf_marketing_review_requests_due(${reviewDelay}, ${hour}, 200)`,
  ]);

  return {
    birthday: await enqueueBatch(
      app, 'birthday', birthdays, () => ({}),
      (c) => c.period!, (c) => c.customer_id),
    holiday: await enqueueBatch(
      app, 'holiday', holidays, (c) => ({ holiday_name: c.holiday_name ?? '' }),
      (c) => c.period!, (c) => c.customer_id),
    winback: await enqueueBatch(
      app, 'winback', winbacks, (c) => ({ days_since: String(c.days_since ?? '') }),
      (c) => c.period!, (c) => c.customer_id),
    /*
     * ⚠️ 求评的去重维度是**工单**，不是周期：同一位顾客来两次就该被问两次，
     * 而同一张单不该被问第二次。
     */
    reviewRequest: await enqueueBatch(
      app, 'review_request', reviews, () => ({}),
      () => 'ticket_review', (c) => c.ticket_id!),
  };
}

export function startMarketingJob(app: FastifyInstance): void {
  return; // Phase 1: marketing is coming soon.
  const sendHour = Number(process.env['MARKETING_SEND_HOUR'] ?? DEFAULT_SEND_HOUR);
  const winbackDays = Number(process.env['MARKETING_WINBACK_DAYS'] ?? DEFAULT_WINBACK_DAYS);
  const reviewDelayHours = Number(
    process.env['MARKETING_REVIEW_DELAY_HOURS'] ?? DEFAULT_REVIEW_DELAY_HOURS);
  const intervalMs = Number(process.env['MARKETING_INTERVAL_MS'] ?? DEFAULT_INTERVAL_MS);

  const run = async (): Promise<void> => {
    try {
      const res = await runMarketingSweep(app, { sendHour, winbackDays, reviewDelayHours });
      /*
       * 发了 0 条也记一句。这条日志的用途是回答「营销调度到底有没有在跑」——
       * 而在两道闸门打开之前，0 才是正确答案（与 retention / reminder 一致）。
       */
      app.log.info({ ...res, sendHour }, 'marketing sweep');
    } catch (e) {
      app.log.warn({ err: e }, 'marketing sweep failed');
    }
  };

  void run();
  const timer = setInterval(() => void run(), intervalMs);
  timer.unref();
}
