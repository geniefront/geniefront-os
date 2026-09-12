/**
 * 进行中状态的回归护栏。
 *
 * 这些断言对应门店反复报过的同一类现象：「点了没反应，就又点了一次」。
 * HeroUI 原生的 `isPending` 拦得住 press、也保住了焦点，唯独**看不出来**——
 * 样式上只有一条 `pointer-events: none`。适配层补的那点视觉，以及「不要顺手
 * 改用原生 disabled」这条约束，都需要测试守着，不能在后续升级里被悄悄改回去。
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button } from './Button';

describe('Button 的进行中状态', () => {
  it('转圈可见，并以 aria-disabled 告知读屏用户此刻不可用', () => {
    const { container } = render(<Button isPending>保存</Button>);

    expect(container.querySelector('.animate-spin')).not.toBeNull();
    expect(screen.getByRole('button')).toHaveAttribute('aria-disabled', 'true');
    // 文案仍在：转圈是附加信息，不能把用户正在等的那件事挤掉
    expect(screen.getByRole('button')).toHaveTextContent('保存');
  });

  it('进行中时按下不再触发处理函数 —— 重复提交在这里被挡住', async () => {
    const onPress = vi.fn();
    const user = userEvent.setup();
    render(<Button isPending onPress={onPress}>提交</Button>);

    await user.click(screen.getByRole('button'));
    expect(onPress).not.toHaveBeenCalled();
  });

  it('键盘回车同样进不来，且焦点仍留在按钮上', async () => {
    const onPress = vi.fn();
    const user = userEvent.setup();
    render(<Button isPending onPress={onPress}>提交</Button>);

    const button = screen.getByRole('button');
    button.focus();
    /*
     * 进行中的按钮必须保持可聚焦。若改用原生 `disabled`，浏览器会把它移出
     * Tab 序列，用户刚按下的按钮在焦点还停在上面时突然消失于键盘导航之中。
     */
    expect(document.activeElement).toBe(button);

    await user.keyboard('{Enter}');
    expect(onPress).not.toHaveBeenCalled();
  });

  it('未进行中时行为不变：没有转圈，按下照常触发', async () => {
    const onPress = vi.fn();
    const user = userEvent.setup();
    const { container } = render(<Button onPress={onPress}>提交</Button>);

    expect(container.querySelector('.animate-spin')).toBeNull();
    await user.click(screen.getByRole('button'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
