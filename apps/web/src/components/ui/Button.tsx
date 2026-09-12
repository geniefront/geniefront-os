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
import { Loader2 } from 'lucide-react';
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
  /**
   * 进行中。按下后到服务端返回之间必须置起，它同时负责两件事：
   * 显示转圈并变暗（用户知道点到了），以及屏蔽重复提交。
   */
  isPending?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = 'default', size = 'default', onClick, onPress, disabled, isDisabled, isPending, children, ...props },
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

  /*
   * ── 进行中的可见反馈 ────────────────────────────────────────────────────────
   *
   * HeroUI 的 `isPending` 该拦的都拦住了：它置 `aria-disabled`，指针与键盘的
   * press 一律不再触发 onPress，同时保留 `tabindex` 让焦点不丢。**缺的只是
   * 「看得见」**—— 它在样式表里对应的 `status-pending` 仅有 `pointer-events:
   * none` 一条规则，按钮不转圈、不变暗、外观毫无变化，只是突然点不动了。
   * 对用户而言这与卡死无法区分：他们会继续点，或者以为没点上而重新操作。
   *
   * 因此适配层只补视觉：转圈 + 变暗。图标按钮的图标本身换成转圈，避免图标与
   * 转圈并排挤爆固定尺寸的按钮。
   *
   * ⚠️ 不要顺手把 `isPending` 并进 `isDisabled`。`disabled` 会把按钮移出 Tab
   * 序列 —— 用户刚按下的那个按钮在焦点还停在上面时突然不可聚焦，焦点被丢到
   * document.body，键盘用户当场失去位置。拦截由 HeroUI 自己完成，这里不必重复。
   */
  const busy = isPending === true;
  const iconOnly = size === 'icon';
  const content = typeof children === 'function'
    ? children
    : busy
      ? (
        <>
          <Loader2 className={cn('shrink-0 animate-spin', iconOnly ? 'h-4 w-4' : 'h-3.5 w-3.5')} aria-hidden="true" />
          {!iconOnly && children}
        </>
      )
      : children;

  return (
    <HeroButton
      ref={ref}
      variant={VARIANT[variant]}
      size={SIZE[size]}
      isIconOnly={iconOnly}
      isDisabled={isDisabled ?? disabled ?? false}
      isPending={busy}
      className={cn(busy && 'cursor-progress opacity-70', className)}
      {...(handlePress ? { onPress: handlePress } : {})}
      {...props}
    >
      {content as React.ReactNode}
    </HeroButton>
  );
});
