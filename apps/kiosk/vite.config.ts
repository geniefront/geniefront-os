import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '../..', '');
  return {
    plugins: [react()],
    // 5175：前台 5173、技师 5174、门口 5175 —— 三个端能同时开着试整条流程
    server: { port: 5175, host: true },
    define: {
      __API_BASE__: JSON.stringify(env['VITE_API_BASE'] ?? 'https://api.geniefront.com'),
    },
  };
});
