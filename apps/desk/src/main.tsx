import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// ⚠️ 顺序要紧：theme 在前、styles 在后 —— 迁移期旧样式优先，旧屏不受影响
import './theme.css';
import './styles.css';
import App from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode><App /></StrictMode>,
);
