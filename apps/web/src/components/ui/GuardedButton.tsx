import { Tooltip } from '@heroui/react';
import { useLanguage } from '@/LanguageContext';
import { useWriteBlockReason } from '@/lib/permissions';
import { Button, type ButtonProps } from './Button';
import type { PermissionKey } from '@/lib/permissions';

export interface GuardedButtonProps extends ButtonProps {
  /** 执行该操作所需的服务端权限，取值见 `@gf/contracts` 的 `PERMISSIONS`。 */
  permission: PermissionKey;
  /**
   * 无权限时的呈现方式。
   *
   * - `disable`（默认）：置灰并说明原因。适用于该操作是页面主流程的一部分、
   *   隐藏会让界面显得残缺的场景。
   * - `hide`：完全不渲染。适用于敏感操作（退款、日结、薪酬），
   *   对无权限者不必暴露其存在。
   */
  fallback?: 'disable' | 'hide';
}

/**
 * 受权限约束的按钮。
 *
 * ⚠️ **所有写操作入口都应使用本组件，而不是直接使用 `Button`。**
 * 直接使用 `Button` 会绕过权限与离线两道判定，产生「按钮亮着、点下去 403」
 * 或「断网时点了没反应」的行为，两者都会被用户判定为系统故障。
 *
 * 禁用时通过 Tooltip 给出具体原因（无权限 / 已断网），
 * 而不是静默置灰 —— 用户需要知道该找谁，还是等网络恢复。
 */
export function GuardedButton({
  permission, fallback = 'disable', isDisabled, disabled, ...props
}: GuardedButtonProps) {
  const { t } = useLanguage();
  const blockReason = useWriteBlockReason()(permission);

  if (blockReason === 'forbidden' && fallback === 'hide') return null;

  if (blockReason === null) {
    return <Button {...props} isDisabled={isDisabled ?? disabled ?? false} />;
  }

  const reasonText = blockReason === 'offline' ? t('blockedOffline') : t('blockedForbidden');

  return (
    <Tooltip delay={200}>
      {/*
        禁用的按钮不派发指针事件，因此不能直接作为触发元素。
        由 Tooltip.Trigger 包裹一个可聚焦的容器承载悬停与键盘焦点，
        使被禁用的原因在鼠标与键盘两种操作方式下都能被读到。
      */}
      <Tooltip.Trigger aria-label={reasonText}>
        <span className="inline-flex" tabIndex={0}>
          <Button {...props} isDisabled />
        </span>
      </Tooltip.Trigger>
      <Tooltip.Content showArrow>
        <Tooltip.Arrow />
        {reasonText}
      </Tooltip.Content>
    </Tooltip>
  );
}
