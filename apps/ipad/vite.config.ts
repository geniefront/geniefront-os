/// <reference types="vitest" />
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, path.resolve(__dirname, '../..'), '');
  const apiBase = (env['VITE_API_BASE'] ?? '').replace(/\/$/, '');
  const apiOrigin = (() => {
    if (!apiBase) return '';
    try { return new URL(apiBase).origin; } catch { return ''; }
  })();
  const loopbackApi = (() => {
    if (!apiBase) return null;
    try {
      const url = new URL(apiBase);
      return ['localhost', '127.0.0.1', '::1'].includes(url.hostname) ? url : null;
    } catch { return null; }
  })();
  return {
    plugins: [
      react(),
      tailwindcss(),
      {
        name: 'kiosk-production-csp',
        transformIndexHtml(html) {
          // Dev/LAN 地址是动态的，不用静态 meta CSP；生产构建按实际 API origin 收紧。
          if (mode === 'development') return html;
          // 本地 production preview 若从另一台 iPad 打开，会在运行时把 loopback
          // 换成页面 hostname；CSP 同步允许该局域网主机的 API 端口。
          const lanApi = loopbackApi ? `${loopbackApi.protocol}//*:${loopbackApi.port || (loopbackApi.protocol === 'https:' ? '443' : '80')}` : '';
          const connect = ["'self'", apiOrigin, lanApi].filter(Boolean).join(' ');
          const policy = [
            "default-src 'self'",
            "base-uri 'none'",
            "object-src 'none'",
            "frame-ancestors 'none'",
            "form-action 'self'",
            "script-src 'self'",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: blob:",
            `connect-src ${connect}`,
            "worker-src 'self' blob:",
            "manifest-src 'self'",
          ].join('; ');
          return html.replace('<meta charset="UTF-8" />',
            `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`);
        },
      },
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
        '@gf/contracts/phone': path.resolve(__dirname, '../../packages/contracts/src/phoneFormat.ts'),
        '@gf/contracts': path.resolve(__dirname, '../../packages/contracts/src/index.ts'),
      },
    },
    server: { port: 5178, strictPort: true, host: '0.0.0.0' },
    test: {
      environment: 'jsdom',
      setupFiles: ['./vitest.setup.ts'],
      restoreMocks: true,
    },
    build: {
      rollupOptions: {
        output: {
          manualChunks: {
            'vendor-react': ['react', 'react-dom', 'react-router-dom'],
          },
        },
      },
      chunkSizeWarningLimit: 700,
    },
    define: {
      __API_BASE__: JSON.stringify(apiBase),
    },
  };
});
