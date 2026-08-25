/**
 * 页内分栏。
 *
 * ⚠️ **和侧边栏是两件事。** 侧边栏切换的是「我现在在干什么」，
 * 分栏切换的是「同一件事的哪一面」—— 模板 / 已签 / 发出去的链接
 * 都属于「健康表」这一件事，拆成三个侧边栏入口只会让侧栏更长，
 * 而前台一天点不了几次。
 *
 * 基于 Radix：键盘左右键切换、`aria-selected`、面板与标签的关联
 * 都是它给的。这几条单独看都不难，凑齐并且不出错很难。
 */

import * as T from '@radix-ui/react-tabs';
import type { ReactNode } from 'react';
import { cn } from './cn';

export function Tabs({ value, onValueChange, items, children, className }: {
  value: string;
  onValueChange: (v: string) => void;
  items: ReadonlyArray<{ value: string; label: string; count?: number }>;
  children: ReactNode;
  className?: string;
}) {
  return (
    <T.Root value={value} onValueChange={onValueChange} className={cn('w-full', className)}>
      <T.List className="mb-5 flex gap-1 border-b border-line">
        {items.map((i) => (
          <T.Trigger
            key={i.value}
            value={i.value}
            className={cn(
              'relative -mb-px flex min-h-tap-sm cursor-pointer items-center gap-2 px-4',
              'text-sm font-semibold text-ink-3 transition-colors',
              'hoverable:hover:text-ink-2',
              'focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ink',
              'data-[state=active]:text-ink',
              'data-[state=active]:after:absolute data-[state=active]:after:inset-x-0',
              'data-[state=active]:after:-bottom-px data-[state=active]:after:h-0.5',
              'data-[state=active]:after:bg-ink',
            )}
          >
            {i.label}
            {i.count !== undefined && i.count > 0 && (
              <span className="tnum rounded-sm bg-neutral-100 px-1.5 py-0.5 text-2xs text-ink-2">
                {i.count}
              </span>
            )}
          </T.Trigger>
        ))}
      </T.List>
      {children}
    </T.Root>
  );
}

export const TabPanel = T.Content;
