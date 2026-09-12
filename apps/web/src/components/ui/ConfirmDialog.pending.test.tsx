/**
 * 二次确认弹窗的防重护栏。
 *
 * 这个弹窗守着的全是不可逆操作（作废单据、退款、删除员工、批量删除通知）。
 * 确认键在 `onConfirm` 兑现之前必须锁住并转圈 —— 否则网络稍慢，前台再按一次
 * 就是第二笔退款。
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfirmDialog } from './Modal';
import { LanguageProvider } from '@/LanguageContext';

function renderDialog(onConfirm: () => Promise<void>) {
  return render(
    <LanguageProvider>
      <ConfirmDialog
        isOpen
        onOpenChange={() => {}}
        title="确认作废"
        confirmLabel="确认作废"
        tone="danger"
        onConfirm={onConfirm}
      />
    </LanguageProvider>,
  );
}

describe('ConfirmDialog 的进行中状态', () => {
  it('确认键在兑现之前只生效一次，连按不会重复提交', async () => {
    let release!: () => void;
    const onConfirm = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const user = userEvent.setup();
    renderDialog(onConfirm);

    const confirm = screen.getByRole('button', { name: '确认作废' });
    await user.click(confirm);
    await user.click(confirm);
    await user.click(confirm);

    expect(onConfirm).toHaveBeenCalledTimes(1);
    release();
  });

  it('进行中显示转圈，并锁住取消键以免中途丢状态', async () => {
    let release!: () => void;
    const onConfirm = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const user = userEvent.setup();
    renderDialog(onConfirm);

    await user.click(screen.getByRole('button', { name: '确认作废' }));

    // 弹窗经 portal 渲染到 body 上，不在 render 返回的 container 里
    expect(document.body.querySelector('.animate-spin')).not.toBeNull();
    expect(screen.getByRole('button', { name: /取消|Cancel/ })).toBeDisabled();
    release();
  });
});
