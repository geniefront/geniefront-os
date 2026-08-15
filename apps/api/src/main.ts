/**
 * 生产入口。
 *
 * 单独一个文件而不是在 server.ts 里判断 `argv[1].endsWith('server.ts')` ——
 * 那种写法打包之后就失效了（argv[1] 变成 server.mjs，监听那段静默不执行，
 * 容器起来了但不听端口，日志还是空的，很难查）。
 * 入口就该是入口。
 */

import { buildServer } from './server';

const app = buildServer();
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
