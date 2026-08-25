import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// ⚠️ 顺序要紧：theme 必须在前 —— 它 `@import "tailwindcss"`，
// 那一句才建立起 theme/base/components/utilities 的层叠顺序。
// styles.css 里的 `@layer base { … }` 要挂到这个顺序上才生效（见那份文件里的长注释）。
import './theme.css';
import './styles.css';
import App from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode><App /></StrictMode>,
);
