import {startVoiceSnapshots} from './voice/snapshotWorker';
/**
 * 生产入口。
 *
 * 单独一个文件而不是在 server.ts 里判断 `argv[1].endsWith('server.ts')` ——
 * 那种写法打包之后就失效了（argv[1] 变成 server.mjs，监听那段静默不执行，
 * 容器起来了但不听端口，日志还是空的，很难查）。
 * 入口就该是入口。
 */

import { startEmailService } from './email/service';
import { buildServer } from './server';
import { startVoiceProcessing } from './voice/worker';
import { startCallReconciler } from './telnyx/schedule';
import { startRetentionJob } from './ops/retention';
import { startReminderJob } from './notify/reminder';
import { startOutboxSweepJob } from './ops/outboxSweep';
import { startLicenseSweepJob } from './ops/licenseSweep';
import { startMarketingJob } from './notify/marketing';
import { startReviewSyncJob } from './reviews/job';
import { assertCommunicationSafety } from './comms/mode';
import { assertOutboundLinkSafety } from './links';
import { assertManageTokenWrapSafety } from './public/bookingToken';

/**
 * ⭐ 在建服务之前就拦。
 *
 * capture 模式和固定 OTP 在生产的失败都是**静默**的：信被吞掉、验证码人人可用，
 * 没有任何一条日志会让人发现。静默失败只能用「起不来」来防
 * （`comms/mode.ts` 的长注释）。放在这里而不是 `buildServer()` 里：
 * 测试会建很多次服务，那里抛异常等于把整个测试套件绑在环境变量上。
 */
try {
  assertCommunicationSafety();
  assertOutboundLinkSafety();
  assertManageTokenWrapSafety();
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}

const app = buildServer();

// 通话对账（sql/0037）。默认关，`TELNYX_RECONCILE_MINUTES=15` 打开。
// ⚠️ 只在真正的入口起 —— 测试里 buildServer() 会被建很多次，
// 每次都挂一个定时器的话，一跑测试就是几十个后台任务在抢同一批会话
startCallReconciler(app);
startVoiceProcessing(app);
startVoiceSnapshots(app);

// 幂等表保留期清理（AUD-09）。同上：只在真正的入口挂定时器。
startRetentionJob(app);
// 次日预约提醒。判定口径在 sql/0088 的 gf_appointments_due_for_reminder()
startReminderJob(app);
// 发件箱兜底扫描。计费类的信没有任何业务动作会触发投递（sql/0090）
startOutboxSweepJob(app);
/*
 * 订阅码到期扫描（sql/0120）。
 * ⚠️ 这一条不能不挂：订阅码没有 webhook，到期这件事没有任何人会来通知我们 ——
 * 少了它的表现是一家 30 天的店永久免费，而且不报错。
 */
startLicenseSweepJob(app);
startEmailService(app);
/*
 * 营销四事件（生日 / 节日 / 唤回 / 求评）。
 * ⚠️ 接上不等于会发出去：每一条仍要过完规则、订阅、10DLC、发件域名
 * 与静默时段那几道闸门（`notify/marketing.ts` 文件头）。
 */
startMarketingJob(app);

// 外部评价采集（sql/0084，05 §8）。默认关，`REVIEW_SYNC_INTERVAL_MINUTES=60` 打开。
// ⚠️ 打开之前先用 staging 的 POST /v1/desk/reviews/sync 把整条链路验一遍 ——
// 这条任务每一轮都真花钱（Bright Data 按记录条数计费）。
startReviewSyncJob(app);
const port = Number(process.env.PORT ?? 3000);

// 滚动部署时要优雅退出：tini 转发 SIGTERM 过来，
// 我们把在途请求处理完再关，不然客户端会看到连接被掐断
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    app.log.info(`${sig} 收到，正在关闭`);
    void app.close().then(() => process.exit(0));
  });
}

app.listen({ port, host: '0.0.0.0' })
  .then(() => app.log.info(`listening on :${port}`))
  .catch((e) => { app.log.error(e); process.exit(1); });
