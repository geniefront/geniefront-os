/**
 * 空列表的统一画面。别让前台盯着一块什么都没有的白色区域猜是没数据还是没加载完 ——
 * 一句话说清楚现在是什么状态，能做什么就给个按钮。
 */
import * as React from 'react';
import { EmptyState as HeroEmptyState } from '@heroui-pro/react/empty-state';
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
    <HeroEmptyState className={cn('px-6 py-14 text-center', className)}>
      <HeroEmptyState.Header>
        {icon ? <HeroEmptyState.Media variant="icon" className="rounded-xl text-slate-400 [&>svg]:size-5">{icon}</HeroEmptyState.Media> : null}
        <HeroEmptyState.Title className="text-sm font-medium text-slate-800">{title}</HeroEmptyState.Title>
        {description ? <HeroEmptyState.Description className="max-w-sm text-sm leading-5 text-slate-500">{description}</HeroEmptyState.Description> : null}
      </HeroEmptyState.Header>
      {action ? <HeroEmptyState.Content>{action}</HeroEmptyState.Content> : null}
    </HeroEmptyState>
  );
}
