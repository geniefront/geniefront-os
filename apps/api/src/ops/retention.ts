/**
 * 保留期清理（AUD-09）。
 *
 * ## 为什么需要
 *
 * `command_idempotency` 每一次 desk 写操作都会新增一行，连同整个
 * `result_json`。这张表有 `at` 列，但没有 TTL、没有分区、没有清理任务 ——
 * 全仓唯一的 `delete from command_idempotency` 都在测试文件里。
 *
 * 按 01-ARCHITECTURE 的目标量级（1000 店 × 100 单/天 × 约 10 条命令/单），
 * 大约每天一百万行 JSONB，压在那份文档自己称作核心单点的托管 Postgres 上。
 * 文档 §4 给 appointments / ticket_items / audit_log / messages 预留了分区，
 * 唯独漏了长得最快的这一张。
 *
 * ## 为什么在应用里定时，而不是 pg_cron
 *
 * 托管实例上 `pg_cron` 不一定开着，而「上线时忘了开扩展」是一种**静默**失败：
 * 表照样在涨，谁也不会收到通知。放在应用里，跑没跑得起来日志里看得见，
 * 删了多少行也看得见。
 *
 * ⚠️ 清理**只删过了窗口的行**。窗口内的删掉的话，一次合法重试会被当成
 * 新请求重新执行 —— 那正是这张表要防的事故。下限钳在数据库函数里
 * （`gf_purge_command_idempotency`），应用这边传什么都突破不了。
 */

import type { FastifyInstance } from 'fastify';
import { sql } from '@gf/db';

/** 默认保留 48 小时。够覆盖「门店周末断网、周一补录」这种真实重试。 */
const DEFAULT_RETAIN_HOURS = 48;
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;

export async function purgeCommandIdempotency(retainHours = DEFAULT_RETAIN_HOURS): Promise<number> {
  const rows = await sql<{ removed: number }[]>`
    select gf_purge_command_idempotency(${retainHours}) as removed`;
  return rows[0]?.removed ?? 0;
}

/**
 * 挂上定时清理。
 *
 * ⚠️ 只在真正的入口调（`main.ts`）—— `buildServer()` 在测试里会被建很多次，
 * 每次都挂一个定时器的话，一跑测试就是几十个后台任务在删同一张表。
 * 和 `startCallReconciler` 同一条纪律。
 */
export function startRetentionJob(app: FastifyInstance): void {
  const hours = Number(process.env['IDEMPOTENCY_RETAIN_HOURS'] ?? DEFAULT_RETAIN_HOURS);
  const intervalMs = Number(process.env['RETENTION_INTERVAL_MS'] ?? DEFAULT_INTERVAL_MS);

  const run = async (): Promise<void> => {
    try {
      const removed = await purgeCommandIdempotency(hours);
      // 删了 0 行也记一句：这条日志的用途是回答「清理到底有没有在跑」，
      // 只在删到东西时才记的话，那个问题就没有答案了
      app.log.info({ removed, retainHours: hours }, 'command_idempotency retention');
    } catch (e) {
      // 清理失败不该影响服务。表涨大是慢性问题，重启一次进程不是解法
      app.log.warn({ err: e }, 'command_idempotency retention failed');
    }
  };

  void run();
  const timer = setInterval(() => void run(), intervalMs);
  timer.unref();
}
