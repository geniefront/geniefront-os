import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ mode }) => {
  // 从仓库根读 .env，前端只取 VITE_ 前缀以外我们显式挑的几个公开值
  const env = loadEnv(mode, '../..', '');
  return {
    plugins: [react(), tailwindcss()],
    // 5173 常被别的项目占着；固定一个不撞的口，省得每次起在随机端口
    server: { port: 5183, strictPort: true },
    define: {
      __SUPABASE_URL__: JSON.stringify(env['SUPABASE_URL']),
      __SUPABASE_ANON_KEY__: JSON.stringify(env['SUPABASE_ANON_KEY']),
      __API_BASE__: JSON.stringify(env['VITE_API_BASE'] ?? 'https://api.geniefront.com'),
    },
  };
});
