/**
 * 自制浮层的键盘行为回归。
 *
 * 三条断言对应三种此前不成立的情形：焦点进不去、Tab 会走出去、Esc 关不掉。
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useDialogChrome } from './dialogChrome';

function Dialog({ onClose }: { onClose: () => void }) {
  const ref = useDialogChrome(true, onClose);
  return (
    <div ref={ref} role="dialog" aria-modal="true" aria-label="测试弹窗">
      <button>第一个</button>
      <button>最后一个</button>
    </div>
  );
}

describe('useDialogChrome', () => {
  it('打开时把焦点送进浮层', () => {
    render(<Dialog onClose={() => {}} />);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '第一个' }));
  });

  it('Esc 关闭', () => {
    const onClose = vi.fn();
    render(<Dialog onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('Tab 到最后一个再按就绕回第一个 —— 不绕会走进被遮住的页面', () => {
    render(<Dialog onClose={() => {}} />);
    const last = screen.getByRole('button', { name: '最后一个' });
    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '第一个' }));
  });
});
