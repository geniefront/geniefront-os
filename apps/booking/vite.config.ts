import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '../..', '');
  return {
    plugins: [react()],
    // 5176：前台 5173/5183、技师 5174、门口 5175、预约页 5176 ——
    // 全开着才能一眼看到「客人在官网上订完，前台看板 2 秒内出现」
    server: { port: 5176, host: true },
    define: {
      /**
       * ⚠️ 开发时默认打**本地** API，不是生产。
       *
       * 另外三个端默认指生产（它们平时对着生产调界面没问题），
       * 但这一页每点一下「确认预约」都会**真的建出一条预约** ——
       * 默认指生产等于在真门店的日程表上留垃圾。
       */
      __API_BASE__: JSON.stringify(
        env['VITE_API_BASE']
        ?? (mode === 'development' ? 'http://localhost:3000' : 'https://api.geniefront.com')),
    },
  };
});
