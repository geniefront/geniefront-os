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
    <div className={cn('flex flex-col gap-4 border-b border-slate-200 pb-5 sm:flex-row sm:items-start sm:justify-between', className)}>
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-950 sm:text-[1.75rem]">{title}</h1>
        {description ? <p className="mt-1.5 max-w-3xl text-sm leading-5 text-slate-500">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
