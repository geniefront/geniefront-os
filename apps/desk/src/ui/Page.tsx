/**
 * 版式原语。
 *
 * 原来 25 个屏各写各的标题和间距 —— 那才是「乱」的结构性原因，
 * 换 token 治不了。所有屏共用这一套骨架之后，
 * 「这一屏叫什么、副标题写什么、动作放哪」不再是每次重新决定的事。
 */
import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from './cn';

export const Page = ({ className, ...p }: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('max-w-[1400px] px-7 pb-10 pt-6 max-lg:px-4', className)} {...p} />
);

/** 页头：标题 + 一句副文 + 右侧动作。副文用来放当下的汇总，不放解释 */
export function PageHeader({ title, sub, actions }: {
  title: string;
  sub?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-5 flex min-h-tap-sm items-start gap-4 max-sm:flex-wrap">
      <div className="min-w-0 flex-1">
        <h1 className="text-xl font-bold tracking-[-0.025em] leading-tight">{title}</h1>
        {sub && <div className="mt-1 flex items-center gap-1.5 text-xs text-ink-3">{sub}</div>}
      </div>
      {actions && <div className="flex items-center gap-2.5">{actions}</div>}
    </div>
  );
}

/** 一屏里的分区。标题不用卡片包，靠字重和留白分层 */
export function Section({ title, extra, children, className }: {
  title?: string; extra?: ReactNode; children: ReactNode; className?: string;
}) {
  return (
    <section className={cn('mt-7 first:mt-0', className)}>
      {title && (
        <div className="mb-3 flex items-center gap-3">
          <h2 className="text-base font-semibold tracking-[-0.01em]">{title}</h2>
          {extra && <div className="ml-auto text-xs text-ink-3">{extra}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

/** 全大写小标签。列头、字段名 */
export const Label = ({ className, ...p }: HTMLAttributes<HTMLSpanElement>) => (
  <span className={cn('text-2xs font-bold uppercase tracking-[0.07em] text-ink-3', className)} {...p} />
);

/** 空状态。图标 + 一句话 + 可选的下一步 */
export function Empty({ icon, title, hint, action }: {
  icon?: ReactNode; title: string; hint?: ReactNode; action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center rounded-lg border border-line bg-surface px-6 py-12 text-center shadow-card">
      {icon && <div className="text-ink-3">{icon}</div>}
      <div className="mt-3.5 text-lg font-bold tracking-[-0.02em]">{title}</div>
      {hint && <div className="mt-2 max-w-[380px] text-xs text-ink-3">{hint}</div>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
