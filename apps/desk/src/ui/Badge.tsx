/**
 * 状态标记。
 *
 * ⚠️ **默认是灰的。** 彩色要留给真正需要人反应的东西 ——
 * 满屏彩色徽章的时候，真正要紧的那一个反而看不见了。
 *
 * ⚠️ 徽章**永远带文字**，不做纯色块。
 * 宪法第 11 条：状态不能只靠颜色表达（色觉障碍 + 廉价 iPad 屏）。
 */
import { cva, type VariantProps } from 'class-variance-authority';
import type { CSSProperties, HTMLAttributes } from 'react';
import { cn } from './cn';

const badge = cva(
  'inline-flex items-center gap-1.5 rounded-sm px-2.5 py-1 text-xs font-semibold leading-tight whitespace-nowrap [&_svg]:shrink-0',
  {
    variants: {
      tone: {
        mute: 'bg-neutral-100 text-ink-2',
        ok: 'bg-ok-soft text-ok',
        warn: 'bg-warn-soft text-warn',
        danger: 'bg-danger-soft text-danger',
        brand: 'bg-brand-soft text-brand',
        /** 最轻的一档：只描边。给「点钟」这类要标出来但不该抢眼的 */
        line: 'bg-transparent text-ink-2 shadow-[inset_0_0_0_1px_var(--color-line-2)]',
      },
    },
    defaultVariants: { tone: 'mute' },
  },
);

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badge> {}

export const Badge = ({ className, tone, ...p }: BadgeProps) => (
  <span className={cn(badge({ tone }), className)} {...p} />
);

/**
 * 状态点。只跟文字一起用，不单独承载信息（宪法第 11 条）。
 *
 * ⚠️ 颜色默认取 `currentColor` —— 让它跟着外面那句文字走。
 * 房态那种要点出自己颜色的地方传 `style={{ color: … }}`。
 */
export const Dot = ({ className, style }: {
  className?: string;
  style?: CSSProperties;
}) => (
  <span className={cn('size-1.5 shrink-0 rounded-full bg-current', className)}
        style={style} aria-hidden />
);
