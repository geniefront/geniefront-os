/**
 * 把内容渲染到 <body> 底下。
 *
 * ⚠️ 为什么需要它：`<main>` 开了 `isolation: isolate`，页面内容**永远盖不到顶栏和侧栏**
 * （之前 Schedule 的 `z-50` 表头就把语言菜单压住了）。代价是页面里那些
 * `position: fixed` 的全屏弹窗也被关在这一层里 —— 它们必须 portal 出去才能盖住整屏。
 *
 * 新写的弹窗直接用 `ui/Modal`（HeroUI 自己就是 portal 的），这个组件是给
 * 手写的全屏浮层留的逃生口。
 */
import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export function Portal({ children }: { children: ReactNode }) {
  // SSR / 首帧还没有 document 时不渲染，挂载后再补上
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;
  return createPortal(children, document.body);
}
