/**
 * 通话对账的定时任务。
 *
 * ## 为什么是「定时拉」而不是「等推送」
 *
 * 见 `conversations.ts` 开头那段：挂机 webhook 可能永远不来，而漏掉它是
 * **静默漏账**（没扣客户的语音分钟，月底才发现，且没有任何报错）。
 *
 * ## 两台机器同时跑会不会记两遍
 *
 * 不会。写库走的是 `call.record`，幂等键是 call_session_id ——
 * 第二台跑到同一通电话时命中的是缓存，处理器根本不执行。
 * 这也是为什么这里敢用最土的 `setInterval` 而不去引一个调度器
 * （宪法第 10 条：不自管状态）。
 *
 * ⚠️ 默认**关**。`TELNYX_RECONCILE_MINUTES=15` 打开，值是间隔分钟数。
 * 关着的时候可以手动跑 `ops/reconcileCalls.ts`。
 */

import type { FastifyInstance } from 'fastify';
import { reconcileCalls } from './reconcile';

export function startCallReconciler(app: FastifyInstance): void {
  const minutes = Number(process.env['TELNYX_RECONCILE_MINUTES'] ?? 0);
  if (!Number.isFinite(minutes) || minutes <= 0) return;

  const run = () => {
    // 每次多往回看一倍的时间：一次跑失败（Telnyx 抖一下）不该让那几通
    // 电话永远漏掉 —— 下一轮会把它们再扫一遍，重复的部分幂等挡着
    void reconcileCalls({ sinceMinutes: Math.max(30, minutes * 2), log: app.log })
      .catch((e) => app.log.error({ err: e }, 'reconcileCalls 整轮失败'));
  };

  const timer = setInterval(run, minutes * 60_000);
  // 容器关闭时别拖着事件循环不放
  timer.unref();
  app.addHook('onClose', async () => clearInterval(timer));

  app.log.info({ minutes }, '通话对账已开启');
  // 起来之后先跑一轮：刚部署完那一段最容易漏
  setTimeout(run, 20_000).unref();
}
