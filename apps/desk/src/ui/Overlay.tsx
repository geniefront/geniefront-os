/**
 * 浮层三件套：确认框（Dialog）、快捷操作（Popover）、侧边抽屉（Sheet）。
 *
 * 全部基于 Radix。**这是换组件底座最实在的收益** —— 下面这些原来是手搓的，
 * 而且没搓全：
 *
 *   · 焦点陷阱：弹窗开着时 Tab 不该跑到背后的页面上去
 *   · 关闭后焦点归位：回到触发它的那个按钮，不是跳到页首
 *   · Esc 关闭、点遮罩关闭、滚动锁定
 *   · `aria-modal` / `role="dialog"` / 标题关联 —— 读屏软件靠这些
 *   · 触屏与鼠标的差异（Popover 在触屏上要点击开合，不能靠 hover）
 *
 * 这些每一条单独看都不难，凑齐并且不出错很难，而且它们出问题时
 * 表现为「偶尔怪怪的」，不会报错。
 */

import * as Dialog from '@radix-ui/react-dialog';
import * as Popover from '@radix-ui/react-popover';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from './cn';
import { Button } from './Button';

/* ─────────────────────────────────────────────────────────── 确认框 */

export function Modal({
  open, onOpenChange, title, description, children, footer, width = 'md',
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  description?: string;
  children?: ReactNode;
  footer?: ReactNode;
  width?: 'sm' | 'md' | 'lg';
}) {
  const w = { sm: 'max-w-[420px]', md: 'max-w-[560px]', lg: 'max-w-[760px]' }[width];
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-ink/40 data-[state=open]:animate-in data-[state=open]:fade-in" />
        <Dialog.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-50 w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2',
            'flex max-h-[92vh] flex-col overflow-hidden rounded-lg bg-ground shadow-pop',
            w,
          )}
        >
          <div className="flex items-start gap-3 bg-surface px-5 py-4 border-b border-line">
            <div className="min-w-0 flex-1">
              <Dialog.Title className="text-lg font-bold tracking-[-0.02em]">{title}</Dialog.Title>
              {description && (
                <Dialog.Description className="mt-1 text-xs text-ink-2">
                  {description}
                </Dialog.Description>
              )}
            </div>
            <Dialog.Close asChild>
              <Button variant="ghost" size="icon" aria-label="关闭"><X size={18} /></Button>
            </Dialog.Close>
          </div>

          {children && <div className="flex-1 overflow-y-auto p-5">{children}</div>}
          {footer && <div className="flex gap-3 bg-surface px-5 py-4 border-t border-line">{footer}</div>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/* ─────────────────────────────────────────────────────── 快捷操作浮层 */

/**
 * 总览页点技师 / 工位 / 预约弹出的那个。
 *
 * ⚠️ **里面不放不可逆动作。** 取消预约、作废工单要走 Modal 并填原因 ——
 * 在一个可能被误触的浮层里放不可逆操作，是这类看板最常见的事故来源。
 * 需要那类动作时，浮层里放的是「取消预约…」（带省略号），点了再开确认框。
 */
export function QuickMenu({
  trigger, title, subtitle, children, align = 'start',
}: {
  trigger: ReactNode;
  title: string;
  subtitle?: string;
  children: ReactNode;
  align?: 'start' | 'center' | 'end';
}) {
  return (
    <Popover.Root>
      <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align={align}
          sideOffset={6}
          collisionPadding={12}
          className={cn(
            'z-50 w-[232px] rounded p-1.5',
            'bg-surface border border-line-2 shadow-pop',
            'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
          )}
        >
          <div className="border-b border-line px-2.5 pb-2.5 pt-1.5">
            <div className="text-sm font-semibold leading-tight">{title}</div>
            {subtitle && <div className="mt-0.5 text-xs text-ink-3 leading-tight">{subtitle}</div>}
          </div>
          <div className="flex flex-col gap-0.5 pt-1.5">{children}</div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** 浮层里的一行动作。48px —— 比 44 略高，因为它常被手指点 */
export function QuickAction({
  children, onClick, primary = false, danger = false,
}: {
  children: ReactNode;
  onClick?: () => void;
  /** 这一组里最可能被点的那个 */
  primary?: boolean;
  /** 开确认框的入口。**它本身不执行任何不可逆动作** */
  danger?: boolean;
}) {
  return (
    <Popover.Close asChild>
      <button
        type="button"
        onClick={onClick}
        className={cn(
          'flex min-h-12 w-full items-center gap-2.5 rounded-sm px-2.5 text-left text-sm font-medium',
          'transition-colors cursor-pointer',
          'focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ink',
          primary ? 'bg-ink text-white font-semibold hoverable:hover:bg-neutral-800'
            : danger ? 'text-danger hoverable:hover:bg-danger-soft'
            : 'text-ink-2 hoverable:hover:bg-sunken hoverable:hover:text-ink',
        )}
      >
        {children}
      </button>
    </Popover.Close>
  );
}

/* ────────────────────────────────────────────────────────── 侧边抽屉 */

/**
 * 从右侧滑入的面板。开单、改单、结账用它。
 *
 * 用 Dialog 而不是自己写一个固定定位的 div：抽屉同样需要焦点陷阱和滚动锁定，
 * 而这两件事在「抽屉」这个形态上更容易被忘掉 —— 它看起来不像弹窗。
 */
export function Sheet({
  open, onOpenChange, title, description, children, footer, width = 560,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-ink/40" />
        <Dialog.Content
          style={{ maxWidth: width }}
          className={cn(
            'fixed inset-y-0 right-0 z-50 flex w-full flex-col bg-ground shadow-pop',
            'data-[state=open]:animate-in data-[state=open]:slide-in-from-right',
          )}
        >
          <div className="flex items-start gap-3 bg-surface px-5 py-4 border-b border-line">
            <div className="min-w-0 flex-1">
              <Dialog.Title className="text-lg font-bold tracking-[-0.02em]">{title}</Dialog.Title>
              {description && (
                <Dialog.Description className="mt-1 text-xs text-ink-2">
                  {description}
                </Dialog.Description>
              )}
            </div>
            <Dialog.Close asChild>
              <Button variant="ghost" size="icon" aria-label="关闭"><X size={18} /></Button>
            </Dialog.Close>
          </div>

          <div className="flex-1 overflow-y-auto p-5">{children}</div>
          {footer && <div className="flex gap-3 bg-surface px-5 py-4 border-t border-line">{footer}</div>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
