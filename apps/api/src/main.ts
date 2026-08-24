/**
 * 生产入口。
 *
 * 单独一个文件而不是在 server.ts 里判断 `argv[1].endsWith('server.ts')` ——
 * 那种写法打包之后就失效了（argv[1] 变成 server.mjs，监听那段静默不执行，
 * 容器起来了但不听端口，日志还是空的，很难查）。
 * 入口就该是入口。
 */

import { buildServer } from './server';
import { startCallReconciler } from './telnyx/schedule';

const app = buildServer();

// 通话对账（sql/0037）。默认关，`TELNYX_RECONCILE_MINUTES=15` 打开。
// ⚠️ 只在真正的入口起 —— 测试里 buildServer() 会被建很多次，
// 每次都挂一个定时器的话，一跑测试就是几十个后台任务在抢同一批会话
startCallReconciler(app);
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
