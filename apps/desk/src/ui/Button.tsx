/**
 * 按钮。
 *
 * ⭐ **触控尺寸的规矩写在这里，不写在调用方。**
 *
 * 原来每屏都是 `style={{minHeight:'var(--tap)'}}`，25 个屏里漏了几处没人知道。
 * 现在 size 是个受类型约束的枚举，`size="lg"` 就是 64px，写不出 40px 的主按钮。
 * 唯一低于 56px 的是 `icon` 与 `sm`，它们的用途在下面各自注明。
 *
 * 变体只有五个。原来那一堆内联覆盖是「每屏各自发明按钮」的后果 ——
 * 变体多到要翻文档才知道用哪个，等于没有设计系统。
 */

import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ButtonHTMLAttributes } from 'react';
import { cn } from './cn';

const button = cva(
  [
    'inline-flex items-center justify-center gap-2 whitespace-nowrap',
    'rounded font-semibold transition-[background-color,border-color,box-shadow,transform]',
    'duration-100 cursor-pointer select-none',
    'active:translate-y-px',
    'disabled:opacity-40 disabled:pointer-events-none',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink',
    // 触屏上 hover 会「粘住」，只在有精确指针时启用
    '[&_svg]:shrink-0',
  ],
  {
    variants: {
      variant: {
        /** 默认：白底描边。一屏上大多数按钮都是这个 */
        default: 'bg-surface border border-line-2 text-ink hoverable:hover:bg-sunken hoverable:hover:border-ink-3/40',
        /** 主操作 = 近黑实心。**一屏最多一个** —— 两个主按钮等于没有主按钮 */
        primary: 'bg-ink border border-ink text-white shadow-[0_1px_2px_rgb(15_15_15/0.16),0_6px_18px_rgb(15_15_15/0.14)] hoverable:hover:bg-neutral-800',
        /** 「钱真的动了」：收钱、确认发放。跟普通提交区分开 */
        go: 'bg-ok border border-ok text-white shadow-[0_1px_2px_rgb(15_122_82/0.18),0_6px_18px_rgb(15_122_82/0.16)] hoverable:hover:brightness-95',
        /** 不可逆动作。⚠️ 它只负责长得像危险动作，确认框要调用方自己加 */
        danger: 'bg-surface border border-danger/25 text-danger hoverable:hover:bg-danger-soft hoverable:hover:border-danger/40',
        /** 无框。给顶栏的图标按钮、次要文字动作 */
        ghost: 'bg-transparent border border-transparent text-ink-2 hoverable:hover:bg-sunken hoverable:hover:text-ink',
      },
      size: {
        /** 56px —— 触控下限（宪法第 11 条） */
        default: 'min-h-tap px-5 text-base',
        /** 64px —— 主操作 */
        lg: 'min-h-tap-lg px-6 text-base',
        /**
         * 44px —— 只给顶栏、卡片角落这类**次要**动作。
         * 不要拿它做一屏的主按钮：44 是苹果 HIG 的下限，
         * 而这个产品的使用者戴着手套。
         */
        sm: 'min-h-tap-sm px-3.5 text-xs rounded-sm',
        /** 44×44 纯图标。必须给 aria-label，否则读屏软件读不出来 */
        icon: 'min-h-tap-sm size-tap-sm p-0 rounded-sm',
      },
      block: { true: 'w-full', false: '' },
    },
    defaultVariants: { variant: 'default', size: 'default', block: false },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof button> {
  /** 渲染成别的标签（比如 <a>）而保留按钮样式 */
  asChild?: boolean;
}

export function Button({
  className, variant, size, block, asChild = false, type = 'button', ...props
}: ButtonProps) {
  const Comp = asChild ? Slot : 'button';
  return (
    <Comp
      // ⚠️ 默认 type="button"。漏了的话表单里的按钮会变成 submit 而整页刷新 ——
      // 这个 bug 只在恰好被放进 <form> 时出现，很难复现
      {...(asChild ? {} : { type })}
      className={cn(button({ variant, size, block }), className)}
      {...props}
    />
  );
}
