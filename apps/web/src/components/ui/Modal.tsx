/**
 * 受控弹窗 + 二次确认弹窗。
 *
 * 前台的操作里有一批是不可逆的（作废单据、退款、删除员工），这些必须先问一句。
 * 危险操作统一走 `<ConfirmDialog tone="danger">`，样式和措辞就不用每个页面各编一套。
 */
import * as React from 'react';
import { Modal as HeroModal, Button } from '@heroui/react';
import { Loader2 } from 'lucide-react';
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
  /*
   * ⚠️ 确认按钮必须自带进行中状态。
   *
   * 这个弹窗守着的全是不可逆操作（作废单据、退款、删除员工）。此前按下确认后
   * 到 `onConfirm` 兑现之间，按钮外观毫无变化也不拦第二次按下 —— 网络稍慢，
   * 前台再点一次就是第二笔退款。
   *
   * `runningRef` 与 `running` 两者都要：状态更新要等下一次渲染才生效，而连续
   * 两次点击可能落在同一批里；ref 是同步的，能挡住这种情况。
   */
  const [running, setRunning] = React.useState(false);
  const runningRef = React.useRef(false);

  // 弹窗关闭后重置，避免下次打开时还停在上一次的进行中状态
  React.useEffect(() => {
    if (!isOpen) { runningRef.current = false; setRunning(false); }
  }, [isOpen]);

  const handleConfirm = async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    setRunning(true);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch {
      // 失败时留着弹窗，toast 才看得到
    } finally {
      runningRef.current = false;
      setRunning(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title={title}
      {...(description !== undefined ? { description } : {})}
      size="sm"
      footer={
        <div className="flex gap-2 justify-end w-full">
          <Button variant="tertiary" onPress={() => onOpenChange(false)} isDisabled={running} aria-label={t('cancel')}>
            {t('cancel')}
          </Button>
          <Button
            variant={tone === 'danger' ? 'danger' : 'primary'}
            aria-label={typeof confirmLabel === 'string' ? confirmLabel : t('confirm')}
            isDisabled={running}
            isPending={running}
            aria-busy={running || undefined}
            className={running ? 'cursor-progress opacity-70' : undefined}
            onPress={() => { void handleConfirm(); }}
          >
            {running ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden="true" /> : null}
            {confirmLabel ?? t('confirm')}
          </Button>
        </div>
      }
    />
  );
}
