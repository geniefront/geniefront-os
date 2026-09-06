/**
 * 受控弹窗 + 二次确认弹窗。
 *
 * 前台的操作里有一批是不可逆的（作废单据、退款、删除员工），这些必须先问一句。
 * 危险操作统一走 `<ConfirmDialog tone="danger">`，样式和措辞就不用每个页面各编一套。
 */
import * as React from 'react';
import { Modal as HeroModal, Button } from '@heroui/react';
import { useLanguage } from '@/LanguageContext';

export interface ModalProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'cover' | 'full';
}

export function Modal({
  isOpen, onOpenChange, title, description, children, footer, size = 'md',
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
      onOpenChange={onOpenChange}
      className="!z-[300]"
    >
        <HeroModal.Container size={size} className="!z-[301]">
          <HeroModal.Dialog>
            <HeroModal.CloseTrigger />
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
