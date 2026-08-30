/// <reference types="vitest" />
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, path.resolve(__dirname, '../..'), '');
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
        '@gf/payroll': path.resolve(__dirname, '../../packages/payroll/src/index.ts'),
      },
    },
    server: { port: 5180, strictPort: true },
    test: {
      environment: 'jsdom',
      setupFiles: ['./vitest.setup.ts'],
      restoreMocks: true,
    },
    define: {
      __API_BASE__: JSON.stringify(env['VITE_API_BASE'] ?? 'http://localhost:3000'),
    },
  };
});
