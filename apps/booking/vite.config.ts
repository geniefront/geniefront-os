/// <reference types="vitest" />
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, path.resolve(__dirname, '../..'), '');
  const apiBase = (env['VITE_API_BASE'] ?? (mode === 'development' ? 'http://localhost:3000' : ''))
    .replace(/\/$/, '');
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: { '@': path.resolve(__dirname, './src') },
    },
    server: { port: 5176, strictPort: true, host: '0.0.0.0' },
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
            'vendor-query': ['@tanstack/react-query'],
          },
        },
      },
    },
    define: {
      __API_BASE__: JSON.stringify(apiBase),
    },
  };
});
