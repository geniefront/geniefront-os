/**
 * 受控弹窗 + 二次确认弹窗。
 *
 * 前台的操作里有一批是不可逆的（作废单据、退款、删除员工），这些必须先问一句。
 * 危险操作统一走 `<ConfirmDialog tone="danger">`，样式和措辞就不用每个页面各编一套。
 */
import * as React from 'react';
import { Modal as HeroModal, Button } from '@heroui/react';
import { useLanguage } from '@/LanguageContext';
import { cn } from '@/lib/utils';

export interface ModalProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'cover' | 'full';
  className?: string;
  /**
   * 提交进行中：屏蔽一切「顺手关掉」的路径。
   *
   * 取消按钮加 `isDisabled` 是不够的 —— 右上角的 ✕、点遮罩、按 Esc 都会照常
   * 触发 `onOpenChange(false)`。而这些弹窗的确认动作是一串不可回滚的写命令，
   * 中途关掉只会让调用方把结果写进一个已经被清空的状态里，前台则看到一个
   * 「什么都没发生」的界面，实际上单据已经改了。
   */
  isDismissDisabled?: boolean;
}

export function Modal({
  isOpen, onOpenChange, title, description, children, footer, size = 'md', className,
  isDismissDisabled = false,
}: ModalProps) {
  return (
    /*
      这是外部状态驱动的弹窗，直接使用 Backdrop（底层 ModalOverlay）。
      HeroUI Modal.Root 固定创建 DialogTrigger，若没有页面内触发按钮就会产生
      PressResponder 警告；这里的触发入口在调用方，不能伪造隐藏按钮。
    */
    <HeroModal.Backdrop
      variant="blur"
      isOpen={isOpen}
      onOpenChange={(open) => { if (!open && isDismissDisabled) return; onOpenChange(open); }}
      isDismissable={!isDismissDisabled}
      isKeyboardDismissDisabled={isDismissDisabled}
      className="!z-[300]"
    >
        <HeroModal.Container size={size} className={cn("!z-[301]", className)}>
          <HeroModal.Dialog className={className}>
            {!isDismissDisabled && <HeroModal.CloseTrigger />}
            <HeroModal.Header>
              <HeroModal.Heading>{title}</HeroModal.Heading>
              {description ? <p className="text-sm text-slate-500">{description}</p> : null}
            </HeroModal.Header>
            {children ? <HeroModal.Body>{children}</HeroModal.Body> : null}
            {footer ? <HeroModal.Footer>{footer}</HeroModal.Footer> : null}
          </HeroModal.Dialog>
        </HeroModal.Container>
    </HeroModal.Backdrop>
  );
}

export interface ConfirmDialogProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  confirmLabel?: React.ReactNode;
  tone?: 'default' | 'danger';
  onConfirm: () => void | Promise<void>;
}

export function ConfirmDialog({
  isOpen, onOpenChange, title, description, confirmLabel, tone = 'default', onConfirm,
}: ConfirmDialogProps) {
  const { t } = useLanguage();
  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title={title}
      {...(description !== undefined ? { description } : {})}
      size="sm"
      footer={
        <div className="flex gap-2 justify-end w-full">
          <Button variant="tertiary" onPress={() => onOpenChange(false)} aria-label={t('cancel')}>
            {t('cancel')}
          </Button>
          <Button
            variant={tone === 'danger' ? 'danger' : 'primary'}
            aria-label={typeof confirmLabel === 'string' ? confirmLabel : t('confirm')}
            onPress={async () => {
              try {
                await onConfirm();
                onOpenChange(false);
              } catch {
                // 失败时留着弹窗，toast 才看得到
              }
            }}
          >
            {confirmLabel ?? t('confirm')}
          </Button>
        </div>
      }
    />
  );
}
