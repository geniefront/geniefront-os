/**
 * 页头。标题 / 副标题 / 右侧操作区的排版此前每个页面各写一遍，
 * 字号和间距互相对不齐 —— 收成一个组件，顺便统一了信息层级。
 */
import * as React from 'react';
import { cn } from '@/lib/utils';

export interface PageHeaderProps {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}

export function PageHeader({ title, description, actions, className }: PageHeaderProps) {
  return (
    <div className={cn('flex flex-wrap items-start justify-between gap-4', className)}>
      <div className="min-w-0">
        <h1 className="text-2xl font-bold text-slate-900 tracking-tight truncate">{title}</h1>
        {description ? <p className="text-sm text-slate-500 mt-1">{description}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2 shrink-0">{actions}</div> : null}
    </div>
  );
}
