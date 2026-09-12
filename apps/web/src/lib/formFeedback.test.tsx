/**
 * 表单校验落点的回归护栏。
 *
 * 核心约定有三条，每条对应一种曾经的失效方式：
 *   - 错误要落到字段上（只弹 toast 时用户不知道是哪一格）；
 *   - 焦点要跟过去（长表单里字段常在视口之外）；
 *   - 字段看得见时不要重复弹 toast（同一句话说两遍是噪音）。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { useFieldErrors } from './formFeedback';
import { Input } from '@/components/ui/Input';

const toastDanger = vi.fn();
vi.mock('./toast', () => ({ toast: { danger: (m: string) => toastDanger(m) } }));

function Demo({ offscreen = false }: { offscreen?: boolean }) {
  const form = useFieldErrors<'name'>();
  const [name, setName] = useState('');
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        form.clear();
        if (!name.trim()) form.fail('name', '请输入名称');
      }}
    >
      <Input
        {...form.bind('name')}
        aria-label="名称"
        value={name}
        onChange={(e) => { setName(e.target.value); form.clearField('name'); }}
        {...(offscreen ? { style: { position: 'absolute', top: '-9999px' } } : {})}
      />
      <button type="submit">保存</button>
    </form>
  );
}

beforeEach(() => {
  toastDanger.mockClear();
  // jsdom 不实现这两个，hook 里都会调用
  window.requestAnimationFrame = ((cb: FrameRequestCallback) => { cb(0); return 0; }) as typeof requestAnimationFrame;
  Element.prototype.scrollIntoView = vi.fn();
  /*
   * jsdom 不做布局，`getBoundingClientRect()` 恒返回全 0，可见性判定会一律
   * 落到「看不见」那一侧。这里按元素的 style 造一个可信的矩形，让两条分支都
   * 测得到。
   *
   * 顺带说明实现上的取舍：真实浏览器里若取不到尺寸，判定同样会落向「看不见」
   * 从而弹 toast —— 这是刻意选的安全侧，宁可多说一句，也不能让用户按下保存
   * 之后什么反馈都没有。
   */
  Element.prototype.getBoundingClientRect = function (this: HTMLElement) {
    const off = this.style.position === 'absolute' && this.style.top.startsWith('-');
    return (off
      ? { width: 100, height: 20, top: -9999, bottom: -9979, left: 0, right: 100, x: 0, y: -9999, toJSON: () => ({}) }
      : { width: 100, height: 20, top: 10, bottom: 30, left: 10, right: 110, x: 10, y: 10, toJSON: () => ({}) }
    ) as DOMRect;
  };
});

describe('useFieldErrors', () => {
  it('校验失败时字段标红、给出文案，并把焦点移过去', async () => {
    const user = userEvent.setup();
    render(<Demo />);

    await user.click(screen.getByRole('button', { name: '保存' }));

    const field = screen.getByLabelText('名称');
    await waitFor(() => expect(field).toHaveAttribute('aria-invalid', 'true'));
    expect(screen.getByRole('alert')).toHaveTextContent('请输入名称');
    expect(document.activeElement).toBe(field);
  });

  it('字段就在眼前时不额外弹 toast —— 同一句话不说两遍', async () => {
    const user = userEvent.setup();
    render(<Demo />);

    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(toastDanger).not.toHaveBeenCalled();
  });

  it('字段不在视口内时补一条 toast —— 否则用户只看到按了保存却什么都没发生', async () => {
    const user = userEvent.setup();
    render(<Demo offscreen />);

    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(toastDanger).toHaveBeenCalledWith('请输入名称'));
  });

  it('用户开始修改后错误态消失', async () => {
    const user = userEvent.setup();
    render(<Demo />);

    await user.click(screen.getByRole('button', { name: '保存' }));
    const field = screen.getByLabelText('名称');
    await waitFor(() => expect(field).toHaveAttribute('aria-invalid', 'true'));

    await user.type(field, '按摩床');
    expect(field).not.toHaveAttribute('aria-invalid');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
