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
  const supabaseUrl = qaMode ? env['TEST_SUPABASE_URL'] : env['SUPABASE_URL'];
  const supabaseAnonKey = qaMode ? env['TEST_SUPABASE_ANON_KEY'] : env['SUPABASE_ANON_KEY'];
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
        '@gf/contracts': path.resolve(__dirname, '../../packages/contracts/src/index.ts'),
      },
    },
    server: { port: 5179, strictPort: true },
    build: {
      rollupOptions: {
        output: {
          // Keep long-lived framework dependencies cacheable across operator
          // console releases. Route chunks then contain only page-level code.
          manualChunks: {
            'vendor-react': ['react', 'react-dom', 'react-router-dom'],
            'vendor-query': ['@tanstack/react-query'],
            'vendor-supabase': ['@supabase/supabase-js'],
            'vendor-icons': ['lucide-react'],
          },
        },
      },
    },
    test: {
      environment: 'jsdom',
    },
    define: {
      __SUPABASE_URL__: JSON.stringify(supabaseUrl),
      __SUPABASE_ANON_KEY__: JSON.stringify(supabaseAnonKey),
      __API_BASE__: JSON.stringify(qaMode ? 'http://127.0.0.1:3000' : (env['VITE_API_BASE'] ?? 'http://localhost:3000')),
    },
  };
});
