/**
 * 订阅码的到期扫描（sql/0120，计划批 5）
 *
 * ## 为什么必须有这一层
 *
 * Stripe 权威下的一切时间判断都跟着 webhook 走：续期、欠费、退订各有一条
 * 事件推着我们改状态。**订阅码没有 webhook** —— 到期这件事没有任何人会
 * 来通知我们。少了这一层的表现是：一家 30 天的店永久免费，而且不会有
 * 任何报错，只有月底对账时少的那笔钱。
 *
 * ## ⚠️ 三个扫描动作都走 SECURITY DEFINER 窄口（sql/0122）
 *
 * 定时任务跑在**没有租户上下文**的连接上，而 `billing_accounts` 是
 * force RLS + tenant_isolation —— 直接写一句 `update … where
 * license_period_end <= now()` 会匹配**零行**，不报错也不告警。
 * 这一条踩过：本文件第一版正是那么写的，三个用例全绿地返回 0。
 *
 * ## 应用内定时，不用 pg_cron
 *
 * 托管实例上 `pg_cron` 不一定开着（与 `ops/retention.ts`、`notify/reminder.ts`
 * 同一个判断）。代价是多实例会各扫一轮 —— 三件事都做成幂等的：
 *   · 置 `expired` 带 `where subscription_status <> 'expired'`
 *   · 提醒信靠 `license_expiry_notified_at` 原子占位 + outbox 唯一索引
 *   · 额度清零推进 `included_period_start`，同一段窗口只会被推一次
 *
 * ## ⚠️ 扫到 0 条也要记日志
 *
 * 这条日志的用途是回答「到期扫描到底有没有在跑」。只在捡到东西时才记的话，
 * 那个问题在最需要答案的时候没有答案（与 `ops/outboxSweep.ts` 同一条纪律）。
 */

import type { FastifyInstance } from 'fastify';
import { sql, withTenant, parseTs } from '@gf/db';
import { ownerShopOf } from '../email/ownerShop';
import { renderLicenseExpiring, formatWhen } from '../email/render';

/** 到期前几天发提醒。两档：一周前给他时间转钱，一天前是最后一次 */
const REMIND_DAYS = [7, 1] as const;
/** 套餐内额度的滚动周期。license 模式没有账单周期，只能按固定天数 */
const INCLUDED_PERIOD_DAYS = 30;
const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;

export interface LicenseSweepResult {
  expired: number;
  remindersQueued: number;
  includedRolled: number;
}

interface LicenseRow {
  org_id: string;
  location_id: string;
  /**
   * ⚠️ postgres.js 回来的 timestamptz **可能是字符串也可能是 Date**
   * （见 @gf/db 的 `parseTs` 注释：vitest 的 VM realm 里 `instanceof Date`
   * 还会失效）。手写 `new Date(v.replace(' ', 'T'))` 在这里踩过一次 ——
   * 结果是 `Invalid time value`，整轮提醒被 catch 吞掉、只留下一句
   * 「该门店提醒失败」，而扫描返回 0 看起来完全正常。
   */
  license_period_end: string | Date;
  days_left: number;
}

interface ExpiredRow {
  org_id: string;
  location_id: string;
}

/**
 * ① 到期 → `expired`（冻结写入，读照常）。
 *
 * ⚠️ 只动 `billing_source = 'license'` 的行。Stripe 权威的行由 webhook 说了算，
 * 在这里顺手改一把的话，两个权威就同时在写同一列 ——
 * 而那正是 0120 整份迁移要防的事。
 */
async function expireDue(app: Pick<FastifyInstance, 'log'>): Promise<number> {
  const rows = await sql<ExpiredRow[]>`select * from gf_license_expire_due(500)`;
  for (const r of rows) {
    app.log.warn({ locationId: r.location_id }, 'license sweep: 订阅码到期，门店转为只读');
  }
  return rows.length;
}

/**
 * ② 到期前提醒。
 *
 * **先原子占位，再入队**（同 `sendActivationOnce` / `sendTrialEndingOnce`）。
 * 反过来的话，两个实例同时扫到会各发一封，老板收到两封一样的催款信。
 *
 * 占位列在续期时会被 `applyLicense` 清空 —— 于是下一个周期的提醒还能再发。
 */
async function remindExpiring(app: Pick<FastifyInstance, 'log'>): Promise<number> {
  const horizon = Math.max(...REMIND_DAYS);
  const due = await sql<LicenseRow[]>`
    select org_id, location_id, license_period_end, days_left
      from gf_license_expiring_soon(${horizon}::int, 200)`;

  let queued = 0;
  for (const row of due) {
    /*
     * 只在两个档位上发。中间那几天不发是有意的：每天一封会被当成噪音
     * 直接屏蔽，然后真正重要的那封（还剩一天）也一起被漏掉。
     */
    if (!REMIND_DAYS.includes(row.days_left as 7 | 1)) continue;

    const tenant = { orgId: row.org_id, locationId: row.location_id, membershipId: null };
    try {
      const sent = await withTenant(tenant, async (tx) => {
        const [claimed] = await tx<{ id: string }[]>`
          update billing_accounts set license_expiry_notified_at = now()
          where location_id = ${row.location_id} and license_expiry_notified_at is null
          returning id`;
        if (!claimed) return false;

        // 收件人只认 owner。找不到就不发 —— 宁可不发，也不要发给一个我们猜的邮箱
        const shop = await ownerShopOf(tx, row.location_id);
        if (!shop) {
          app.log.warn({ locationId: row.location_id },
            'license sweep: 找不到 owner 邮箱，不发到期提醒');
          return false;
        }

        const msg = renderLicenseExpiring({
          shopName: shop.shopName,
          endsAtText: formatWhen(
            parseTs(row.license_period_end).toISOString(), shop.timezone, shop.locale),
          daysLeft: row.days_left,
          locale: shop.locale,
        });

        /*
         * ⚠️ `entity_id` 用**账户 id**，配合 kind 去重。
         * 用 location_id 也一样唯一，但审计和排查时「这封信是对哪个账户发的」
         * 是同一个问题的答案，指向账户更直接。
         */
        await tx`
          insert into email_outbox
            (org_id, location_id, kind, to_email, subject, body_html, body_text,
             entity_type, entity_id)
          values (${row.org_id}, ${row.location_id}, 'license_expiring', ${shop.email},
                  ${msg.subject}, ${msg.html}, ${msg.text},
                  'billing_account', ${shop.accountId}::uuid)
          on conflict (entity_type, entity_id, kind) do nothing`;
        return true;
      });
      if (sent) queued += 1;
    } catch (e) {
      // 一家店失败不该拖垮整轮。下一轮会重新扫到它（占位失败时它还是 null）
      app.log.warn({ err: e, locationId: row.location_id }, 'license sweep: 该门店提醒失败');
    }
  }
  return queued;
}

/**
 * ③ 套餐内额度按 30 天滚动清零。
 *
 * Stripe 权威下清零跟着 `customer.subscription.updated` 里 period_end 的变化走
 * （`applySubscriptionToRow` 的 `renewed`）。license 模式没有那条事件，
 * 只能自己划边界。
 *
 * ⭐ 推进的算法（整段推进、一次补齐多段）在 `gf_license_roll_included`
 * 里，连同「为什么不能把起点设成 now()」的长注释 —— 那句 SQL 必须在
 * definer 之下才能跨租户执行，注释跟着它走比留在这里更不容易漂。
 */
async function rollIncluded(): Promise<number> {
  const rows = await sql<{ location_id: string }[]>`
    select location_id from gf_license_roll_included(${INCLUDED_PERIOD_DAYS}::int, 500)`;
  return rows.length;
}

export async function runLicenseSweep(
  app: Pick<FastifyInstance, 'log'>,
): Promise<LicenseSweepResult> {
  const expired = await expireDue(app);
  const remindersQueued = await remindExpiring(app);
  const includedRolled = await rollIncluded();
  return { expired, remindersQueued, includedRolled };
}

export function startLicenseSweepJob(app: FastifyInstance): void {
  const intervalMs = Number(process.env['LICENSE_SWEEP_INTERVAL_MS'] ?? DEFAULT_INTERVAL_MS);

  const run = async (): Promise<void> => {
    try {
      const res = await runLicenseSweep(app);
      if (res.expired > 0 || res.remindersQueued > 0) {
        app.log.warn(res, 'license sweep: 有门店到期或即将到期');
      } else {
        app.log.info(res, 'license sweep');
      }
    } catch (e) {
      app.log.warn({ err: e }, 'license sweep failed');
    }
  };

  void run();
  const timer = setInterval(() => void run(), intervalMs);
  timer.unref();
}
