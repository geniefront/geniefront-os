/**
 * 卡片与它的几个槽位。
 *
 * 一层、大扩散、极淡的阴影 —— 这一条几乎独力决定了界面看起来是「新」还是「旧」。
 * 原来那个 4px/14px 的双层阴影太实，白卡贴在灰底上像贴纸。
 */
import type { HTMLAttributes } from 'react';
import { cn } from './cn';

type D = HTMLAttributes<HTMLDivElement>;

export const Card = ({ className, ...p }: D) => (
  <div className={cn('bg-surface border border-line rounded-lg shadow-card', className)} {...p} />
);

export const CardHeader = ({ className, ...p }: D) => (
  <div className={cn('flex items-center gap-3 px-5 py-4 border-b border-line', className)} {...p} />
);

export const CardTitle = ({ className, ...p }: HTMLAttributes<HTMLHeadingElement>) => (
  <h3 className={cn('text-lg font-bold tracking-[-0.02em] leading-tight', className)} {...p} />
);

export const CardBody = ({ className, ...p }: D) => (
  <div className={cn('p-5', className)} {...p} />
);

export const CardFooter = ({ className, ...p }: D) => (
  <div className={cn('flex items-center gap-3 px-5 py-4 border-t border-line', className)} {...p} />
);

/**
 * 卡片里再嵌一层（明细块、说明块）。
 * 用底色下沉而不是再加阴影 —— 阴影套阴影，边界就浑了。
 */
export const Sunken = ({ className, ...p }: D) => (
  <div className={cn('bg-sunken border border-line rounded', className)} {...p} />
);
