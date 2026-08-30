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
        '@gf/contracts': path.resolve(__dirname, '../../packages/contracts/src/index.ts'),
      },
    },
    server: { port: 5179, strictPort: true },
    test: {
      environment: 'jsdom',
    },
    define: {
      __SUPABASE_URL__: JSON.stringify(env['SUPABASE_URL']),
      __SUPABASE_ANON_KEY__: JSON.stringify(env['SUPABASE_ANON_KEY']),
      __API_BASE__: JSON.stringify(env['VITE_API_BASE'] ?? 'http://localhost:3000'),
    },
  };
});
