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
    <div className={cn('flex flex-col items-center justify-center text-center py-12 px-6', className)}>
      {icon ? <div className="mb-3 text-slate-300 [&>svg]:w-8 [&>svg]:h-8">{icon}</div> : null}
      <p className="text-sm font-medium text-slate-700">{title}</p>
      {description ? <p className="text-sm text-slate-500 mt-1 max-w-sm">{description}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}
