import { useId } from 'react';
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
  const reasonId = useId();

  if (blockReason === 'forbidden' && fallback === 'hide') return null;

  if (blockReason === null) {
    return <Button {...props} isDisabled={isDisabled ?? disabled ?? false} />;
  }

  const reasonText = blockReason === 'offline' ? t('blockedOffline') : t('blockedForbidden');

  return (
    /*
      禁用的按钮不派发指针事件，因此由可聚焦容器承载悬停与键盘焦点。
      这里不使用 HeroUI Tooltip.Trigger：它要求直接子节点实现 react-aria
      pressable 契约，而普通容器会在每个无权限按钮上产生 PressResponder 警告。
    */
    <span
      className="group relative inline-flex"
      tabIndex={0}
      aria-label={reasonText}
      aria-describedby={reasonId}
    >
      <Button {...props} isDisabled />
      <span
        id={reasonId}
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-2 w-max max-w-64 -translate-x-1/2 rounded-lg bg-slate-900 px-3 py-2 text-xs font-medium text-white opacity-0 shadow-lg transition-opacity group-hover:opacity-100 group-focus:opacity-100"
      >
        {reasonText}
      </span>
    </span>
  );
}
