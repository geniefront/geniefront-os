/**
 * 权限门禁按钮的行为约束。
 *
 * ⚠️ 这里断言的是**用户实际看到的结果**，而不是内部实现：
 * 「按钮是不是可点」「禁用的原因说没说清楚」「无权限时敏感操作有没有露出来」。
 * 该组件的存在理由正是避免两种会被用户判定为系统故障的表现 ——
 * 亮着但点下去 403，以及断网时点了没反应。
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { LanguageProvider } from '@/LanguageContext';
import { GuardedButton } from './GuardedButton';

/**
 * 会话是外部依赖，测试里以最小替身注入。
 *
 * 只替换 `can` 与 `isOnline` 两个字段 —— 它们正是门禁判定的全部输入，
 * 替身越贴近真实契约，测试越不会在无关重构时误报。
 */
const sessionState = { can: (_: string) => true, isOnline: true };
vi.mock('@/lib/session', () => ({
  useSession: () => sessionState,
}));

function renderGuarded(node: ReactNode) {
  return render(<LanguageProvider>{node}</LanguageProvider>);
}

beforeEach(() => {
  sessionState.can = () => true;
  sessionState.isOnline = true;
  try {
    localStorage.clear();
  } catch {
    /* 隐私模式下不可用，忽略 */
  }
});

describe('GuardedButton', () => {
  it('有权限且在线时按钮可用且能触发回调', async () => {
    const onPress = vi.fn();
    renderGuarded(
      <GuardedButton permission="ticket.write" onPress={onPress}>
        结账
      </GuardedButton>,
    );

    const button = screen.getByRole('button', { name: '结账' });
    expect(button).toBeEnabled();
    await userEvent.click(button);
    expect(onPress).toHaveBeenCalledOnce();
  });

  it('断网时按钮禁用，并说明原因是断网而非权限', async () => {
    sessionState.isOnline = false;
    const onPress = vi.fn();
    renderGuarded(
      <GuardedButton permission="ticket.write" onPress={onPress}>
        结账
      </GuardedButton>,
    );

    expect(screen.getByRole('button', { name: '结账' })).toBeDisabled();
    // 断网优先于权限：即便有权限也必须提示断网，否则用户会去找店长要权限
    expect(screen.getByLabelText('网络已断开，暂不可执行写入操作')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '结账' }));
    expect(onPress).not.toHaveBeenCalled();
  });

  it('无权限时默认置灰并说明缺的是权限', () => {
    sessionState.can = () => false;
    renderGuarded(<GuardedButton permission="ticket.void">作废</GuardedButton>);

    expect(screen.getByRole('button', { name: '作废' })).toBeDisabled();
    expect(screen.getByLabelText('当前账号没有此项权限')).toBeInTheDocument();
  });

  it('fallback="hide" 时无权限者看不到该按钮', () => {
    sessionState.can = () => false;
    renderGuarded(
      <GuardedButton permission="ticket.void" fallback="hide">
        作废
      </GuardedButton>,
    );

    expect(screen.queryByRole('button', { name: '作废' })).not.toBeInTheDocument();
  });

  it('fallback="hide" 仅对无权限生效，断网时仍需露出并说明原因', () => {
    // 断网是暂时状态，把按钮整个藏掉会让用户以为功能不存在
    sessionState.isOnline = false;
    renderGuarded(
      <GuardedButton permission="ticket.void" fallback="hide">
        作废
      </GuardedButton>,
    );

    expect(screen.getByRole('button', { name: '作废' })).toBeDisabled();
    expect(screen.getByLabelText('网络已断开，暂不可执行写入操作')).toBeInTheDocument();
  });

  it('禁用原因跟随界面语言', () => {
    localStorage.setItem('gf.lang', 'en');
    sessionState.can = () => false;
    renderGuarded(<GuardedButton permission="ticket.void">Void</GuardedButton>);

    expect(screen.getByLabelText('Your account does not have this permission')).toBeInTheDocument();
  });

  it('调用方自身的 isDisabled 在有权限时依然生效', () => {
    renderGuarded(
      <GuardedButton permission="ticket.write" isDisabled>
        结账
      </GuardedButton>,
    );

    expect(screen.getByRole('button', { name: '结账' })).toBeDisabled();
  });
});
