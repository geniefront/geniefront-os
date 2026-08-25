/**
 * 报错 / 告警条。
 *
 * ## 为什么它不该继续用 Badge 拼
 *
 * 迁移之前，全仓库的报错都是 `<div className="badge badge-danger">✕ {err}</div>`。
 * 三个问题，每一个都只在出错那一刻才暴露：
 *
 *   1. **没有 `role="alert"`** —— 读屏软件不会念出来。前台把界面调成
 *      大字模式、报错在屏幕外的时候，她永远不知道刚才那一下没成
 *   2. **徽章是给状态用的**，它的内边距和行高是按「两三个字」设计的；
 *      一句「技师位已满，上限 1 人，可点『仍然开单』放行」塞进去会挤成一坨
 *   3. ✕ / ⚠ / ℹ 是**字符**，在不同系统上大小和基线差得离谱（styles.css 开头那段）
 *
 * ⚠️ 颜色不是唯一通道（宪法第 11 条）：每一档都有自己的图标。
 */

import { CircleAlert, TriangleAlert, Info, CircleCheck } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from './cn';

const TONE = {
  danger: { cls: 'bg-danger-soft text-danger', Icon: CircleAlert },
  warn:   { cls: 'bg-warn-soft text-warn',     Icon: TriangleAlert },
  ok:     { cls: 'bg-ok-soft text-ok',         Icon: CircleCheck },
  info:   { cls: 'bg-brand-soft text-brand',   Icon: Info },
} as const;

export function Alert({ tone = 'danger', children, className, title }: {
  tone?: keyof typeof TONE;
  children: ReactNode;
  className?: string;
  /** 有标题时正文压到第二行 —— 「怎么办」比「出了什么事」更该被读到 */
  title?: ReactNode;
}) {
  const { cls, Icon } = TONE[tone];
  return (
    <div role="alert"
         className={cn('flex items-start gap-2.5 rounded px-4 py-3', cls, className)}>
      <Icon size={17} className="mt-px shrink-0" />
      <div className="min-w-0 flex-1 text-xs leading-relaxed">
        {title && <div className="mb-1 text-sm font-bold">{title}</div>}
        {children}
      </div>
    </div>
  );
}
