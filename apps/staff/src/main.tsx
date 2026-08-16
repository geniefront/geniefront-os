import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import App from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode><App /></StrictMode>,
);

// PWA：注册 Service Worker，让技师能把它加到主屏。
// ⚠️ 它只缓存应用外壳，绝不做离线写入队列（宪法第 18 条，理由见 public/sw.js）
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js');
  });
}
