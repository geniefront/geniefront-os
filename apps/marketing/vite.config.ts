/// <reference types="vitest" />
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, path.resolve(__dirname, '../..'), '');
  const qaMode = mode === 'qa';
  if (qaMode && (process.env.GF_QA_ALLOW_RESET !== '1' || env['DATABASE_TEST_TARGET'] !== 'isolated')) {
    throw new Error('QA Vite mode requires GF_QA_ALLOW_RESET=1 and DATABASE_TEST_TARGET=isolated');
  }
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
        '@gf/payroll': path.resolve(__dirname, '../../packages/payroll/src/index.ts'),
      },
    },
    server: { port: 5180, strictPort: true },
    build: {
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes('node_modules/lucide-react')) return 'icons';
            if (id.includes('node_modules/react') || id.includes('node_modules/react-router')) return 'react-vendor';
          },
        },
      },
    },
    test: {
      environment: 'jsdom',
      setupFiles: ['./vitest.setup.ts'],
      restoreMocks: true,
    },
    define: {
      __API_BASE__: JSON.stringify(qaMode ? 'http://127.0.0.1:3000' : (env['VITE_API_BASE'] ?? 'http://localhost:3000')),
    },
  };
});
