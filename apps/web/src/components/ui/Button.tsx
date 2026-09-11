/**
 * HeroUI Button 的适配层。
 *
 * 页面里几十处写的是 `onClick`（模板留下来的），而 HeroUI 走 react-aria 的
 * `onPress`。与其去改每一个调用点，不如在这里翻译一次。
 *
 * ⚠️ 翻译不能直接把 `PressEvent` 当成 `MouseEvent` 递过去 —— 它**没有**
 * `stopPropagation` / `preventDefault`，页面里一调就抛 TypeError，
 * 而且是在事件回调里抛，React 只会打一条红字，按钮看起来就是「点了没反应」。
 * 所以这里补一个薄壳：
 *   - `stopPropagation` 是空实现，因为 react-aria 的 usePress **默认就已经**
 *     拦住了底层指针事件的冒泡（要放行得显式调 `continuePropagation`），
 *     调用方想要的效果本来就已经发生了；
 *   - `preventDefault` 转发到 PressEvent 上的同名方法（有就用，没有就空转）。
 *
 * 新写的代码直接用 `onPress` 更准（键盘、触屏都算按下）。
 */
import * as React from 'react';
import { Button as HeroButton } from '@heroui/react';
import { cn } from '@/lib/utils';

type Variant = 'default' | 'outline' | 'ghost' | 'danger' | 'secondary';
type Size = 'default' | 'sm' | 'lg' | 'icon';

const VARIANT: Record<Variant, 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger'> = {
  default: 'primary',
  secondary: 'secondary',
  outline: 'outline',
  ghost: 'ghost',
  danger: 'danger',
};

const SIZE: Record<Size, 'sm' | 'md' | 'lg'> = {
  default: 'md',
  sm: 'sm',
  lg: 'lg',
  icon: 'md',
};

/** 把 react-aria 的 PressEvent 包成调用方以为自己拿到的那种事件 */
function toMouseLike(e: unknown): React.MouseEvent<HTMLButtonElement> {
  const press = e as { target?: unknown; preventDefault?: () => void };
  return {
    ...(press as object),
    target: press?.target,
    currentTarget: press?.target,
    stopPropagation: () => {},
    preventDefault: () => press?.preventDefault?.(),
  } as unknown as React.MouseEvent<HTMLButtonElement>;
}

export interface ButtonProps
  extends Omit<React.ComponentProps<typeof HeroButton>, 'variant' | 'size' | 'onClick'> {
  variant?: Variant;
  size?: Size;
  /** 模板遗留写法，等价于 onPress */
  onClick?: React.MouseEventHandler<HTMLButtonElement>;
  disabled?: boolean;
  title?: string;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = 'default', size = 'default', onClick, onPress, disabled, isDisabled, ...props },
  ref,
) {
  /*
   * 两个都给时**两个都要跑**。此前是 `onPress ?? onClick`：同时传就静默丢掉
   * onClick，而两者写法混用（模板留下 onClick、新代码写 onPress），一次粗心的
   * 合并就能让某个按钮少做一半的事，且不报任何错。
   */
  const handlePress = onPress || onClick
    ? (e: unknown) => {
        onPress?.(e as Parameters<NonNullable<typeof onPress>>[0]);
        onClick?.(toMouseLike(e));
      }
    : undefined;

  return (
    <HeroButton
      ref={ref}
      variant={VARIANT[variant]}
      size={SIZE[size]}
      isIconOnly={size === 'icon'}
      isDisabled={isDisabled ?? disabled ?? false}
      className={cn(className)}
      {...(handlePress ? { onPress: handlePress } : {})}
      {...props}
    />
  );
});
