/**
 * 页面骨架：底下那几团色斑、玻璃顶栏、卡片、底部操作条。
 *
 * ⚠️ `.topbar` / `.card` / `.dock` 都要**同时**写 `glass` 这个类
 * —— 玻璃效果在 `.glass` 上，这三个只管布局（styles.css 里有说明）。
 */

import type { ReactNode } from 'react';
import type { Shop } from '../lib/api';

export type StepName = 'service' | 'time' | 'details' | 'done';

export function Shell({ children }: { children: ReactNode }) {
  return (
    <>
      {/* 玻璃底下必须有东西可透 —— 没有这三团，毛玻璃等于一层灰纱 */}
      <div className="blobs" aria-hidden="true">
        <div className="blob blob-1" />
        <div className="blob blob-2" />
        <div className="blob blob-3" />
      </div>
      <div className="shell">{children}</div>
    </>
  );
}

export function Topbar({ shop, step }: { shop: Shop; step: StepName | null }) {
  const order: StepName[] = ['service', 'time', 'details'];
  const at = step ? order.indexOf(step) : -1;

  return (
    <header className="glass topbar">
      <div style={{ minWidth: 0 }}>
        <h1 className="shop-name">{shop.name}</h1>
        <div className="shop-sub">在线预约</div>
      </div>
      {step && step !== 'done' && (
        <div className="steps" aria-hidden="true">
          {order.map((s, i) => (
            <span key={s}
                  className={`step-dot ${i === at ? 'on' : i < at ? 'past' : ''}`} />
          ))}
        </div>
      )}
    </header>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`glass card fade ${className}`}>{children}</section>;
}

export function Dock({ children }: { children: ReactNode }) {
  return <div className="glass dock">{children}</div>;
}

export function Note({ children, warn = false }: { children: ReactNode; warn?: boolean }) {
  return <div className={`note ${warn ? 'note-warn' : ''}`}>{children}</div>;
}

export function Loading({ label = '正在载入' }: { label?: string }) {
  return (
    <div className="center" style={{ padding: '38px 0', color: 'var(--ink-soft)' }}>
      <span className="spin" />
      <div style={{ marginTop: 12, fontSize: 14 }}>{label}</div>
    </div>
  );
}
