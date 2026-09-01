/**
 * 发件箱的兜底投递扫描（sql/0090）。
 *
 * ## 为什么需要
 *
 * 投递此前**只由业务动作触发**：`appointment.create` 之后、公开预约之后、
 * 入站短信之后。这个设计对预约类是成立的 —— 信入队之后立刻就有一次
 * flush，顾客几秒内就收到。
 *
 * 但它对**不由门店动作产生**的信是失效的，而且方向反了：
 *
 *   · Stripe webhook 写进来的三封计费信，没有任何触发点会投递它们；
 *   · 而**扣款失败的门店会被冻结成只读**，开不了单，也就永远触发不了
 *     那一次 `appointment.create`。
 *
 * 最需要收到「你的卡扣不上了」这封信的店，恰恰是唯一收不到的那家。
 *
 * ## 这一层不替代即时投递，只兜底
 *
 * 入队之后的那次 flush 仍然是主路径 —— 顾客不该等两分钟才收到取消通知。
 * 本扫描只捡「超过 `OUTBOX_SWEEP_MIN_AGE_SEC` 还躺在队里」的，因此正常
 * 情况下它每一轮都扫到空。
 *
 * ⚠️ 也正因为如此，**扫到 0 条也要记日志**：这条日志的用途是回答
 * 「兜底扫描到底有没有在跑」，只在捡到东西时才记的话，那个问题没有答案
 * （与 `ops/retention.ts` 同一条纪律）。
 */

import type { FastifyInstance } from 'fastify';
import { sql } from '@gf/db';
import { flushEmails } from '../email/flush';
import { flushSms } from '../sms/flush';

/** 入队多久之后才算「漏发了」。短于这个窗口的交给入队时那次即时投递。 */
const DEFAULT_MIN_AGE_SEC = 120;
/** 一轮最多处理多少个租户。剩下的下一轮接着来。 */
const DEFAULT_BATCH = 100;
const DEFAULT_INTERVAL_MS = 2 * 60 * 1000;

interface PendingTenant {
  org_id: string;
  location_id: string;
  email_pending: string;
  sms_pending: string;
}

export interface SweepResult {
  tenants: number;
  emailPending: number;
  smsPending: number;
}

export async function runOutboxSweep(
  app: Pick<FastifyInstance, 'log'>,
  opts: { minAgeSec?: number; limit?: number } = {},
): Promise<SweepResult> {
  const minAge = opts.minAgeSec ?? DEFAULT_MIN_AGE_SEC;
  const limit = opts.limit ?? DEFAULT_BATCH;

  const rows = await sql<PendingTenant[]>`
    select * from gf_outbox_pending_tenants(${minAge}, ${limit})`;

  let emailPending = 0;
  let smsPending = 0;

  for (const row of rows) {
    const tenant = { orgId: row.org_id, locationId: row.location_id, membershipId: null };
    emailPending += Number(row.email_pending);
    smsPending += Number(row.sms_pending);
    try {
      /*
       * ⚠️ 串行 await，不是 `void`。这是兜底路径，跑得慢没关系；
       * 而一次性对一百个租户并发发信会把 Resend / Telnyx 的限频撞满，
       * 那时失败的不只是这一批。
       */
      if (Number(row.email_pending) > 0) await flushEmails(tenant, app.log as never);
      if (Number(row.sms_pending) > 0) await flushSms(tenant, app.log as never);
    } catch (e) {
      // 一家店失败不该拖垮整轮。下一轮会重新扫到它
      app.log.warn({ err: e, locationId: row.location_id }, 'outbox sweep: 该门店本轮失败');
    }
  }

  return { tenants: rows.length, emailPending, smsPending };
}

export function startOutboxSweepJob(app: FastifyInstance): void {
  const minAgeSec = Number(process.env['OUTBOX_SWEEP_MIN_AGE_SEC'] ?? DEFAULT_MIN_AGE_SEC);
  const intervalMs = Number(process.env['OUTBOX_SWEEP_INTERVAL_MS'] ?? DEFAULT_INTERVAL_MS);

  const run = async (): Promise<void> => {
    try {
      const res = await runOutboxSweep(app, { minAgeSec });
      if (res.tenants > 0) {
        app.log.warn({ ...res, minAgeSec }, 'outbox sweep: 捡到了漏发的信');
      } else {
        app.log.info({ ...res, minAgeSec }, 'outbox sweep');
      }
    } catch (e) {
      app.log.warn({ err: e }, 'outbox sweep failed');
    }
  };

  void run();
  const timer = setInterval(() => void run(), intervalMs);
  timer.unref();
}
