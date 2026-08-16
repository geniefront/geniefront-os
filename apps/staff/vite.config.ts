import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '../..', '');
  return {
    plugins: [react()],
    // 5174：和前台的 5173 分开，开发时两个端同时开着才能试派单→响铃
    server: { port: 5174, host: true },
    define: {
      __SUPABASE_URL__: JSON.stringify(env['SUPABASE_URL']),
      __SUPABASE_ANON_KEY__: JSON.stringify(env['SUPABASE_ANON_KEY']),
      __API_BASE__: JSON.stringify(env['VITE_API_BASE'] ?? 'https://api.geniefront.com'),
    },
  };
});
