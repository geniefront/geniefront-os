/// <reference types="vitest" />
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  // 从仓库根读 .env，只挑我们显式列出的几个公开值注进构建
  const env = loadEnv(mode, path.resolve(__dirname, '../..'), '');
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
        '@gf/contracts': path.resolve(__dirname, '../../packages/contracts/src/index.ts'),
      },
    },
    // launch.json 里给前台端留的口
    server: { port: 5177, strictPort: true },
    /*
     * 组件测试需要 DOM，故整包使用 jsdom 环境。
     * 纯函数测试在 jsdom 下同样可以运行，为一个包维护两套环境不划算。
     */
    test: {
      environment: 'jsdom',
      setupFiles: ['./vitest.setup.ts'],
      restoreMocks: true,
    },
    build: {
      rollupOptions: {
        output: {
          /*
           * 第三方依赖单独成块。
           *
           * 这些包在版本更新之前内容不变，独立分块可使其在浏览器缓存中长期驻留 ——
           * 业务代码的日常发布不会令门店终端重新下载图表库与 UI 框架。
           */
          manualChunks: {
            'vendor-react': ['react', 'react-dom', 'react-router-dom'],
            'vendor-charts': ['recharts'],
            'vendor-ui': ['@heroui/react', 'react-aria-components', 'motion'],
            'vendor-supabase': ['@supabase/supabase-js'],
            'vendor-query': ['@tanstack/react-query'],
          },
        },
      },
      // 分块之后入口体积已在合理区间，保留告警阈值以便回归时能被发现
      chunkSizeWarningLimit: 700,
    },
    define: {
      __SUPABASE_URL__: JSON.stringify(env['SUPABASE_URL']),
      __SUPABASE_ANON_KEY__: JSON.stringify(env['SUPABASE_ANON_KEY']),
      __API_BASE__: JSON.stringify(env['VITE_API_BASE'] ?? 'http://localhost:3000'),
    },
  };
});
