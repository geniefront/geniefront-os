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
    <HeroModal>
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
    </HeroModal>
  );
}

export interface ConfirmDialogProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  confirmLabel?: React.ReactNode;
  tone?: 'default' | 'danger';
  onConfirm: () => void;
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
          <Button variant="tertiary" onPress={() => onOpenChange(false)}>
            {t('cancel')}
          </Button>
          <Button
            variant={tone === 'danger' ? 'danger' : 'primary'}
            onPress={() => { onConfirm(); onOpenChange(false); }}
          >
            {confirmLabel ?? t('confirm')}
          </Button>
        </div>
      }
    />
  );
}
