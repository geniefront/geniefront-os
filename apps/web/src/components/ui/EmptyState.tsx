/**
 * 空列表的统一画面。别让前台盯着一块什么都没有的白色区域猜是没数据还是没加载完 ——
 * 一句话说清楚现在是什么状态，能做什么就给个按钮。
 */
import * as React from 'react';
import { cn } from '@/lib/utils';

export interface EmptyStateProps {
  icon?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}

export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center justify-center px-6 py-14 text-center', className)}>
      {icon ? <div className="mb-4 grid h-11 w-11 place-items-center rounded-xl bg-slate-100 text-slate-400 [&>svg]:h-5 [&>svg]:w-5">{icon}</div> : null}
      <p className="text-sm font-semibold text-slate-800">{title}</p>
      {description ? <p className="mt-1.5 max-w-sm text-sm leading-5 text-slate-500">{description}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}
