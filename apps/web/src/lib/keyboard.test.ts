import { describe, it, expect } from 'vitest';
import { isTypingTarget } from './keyboard';

describe('isTypingTarget', () => {
  it('原生 input / textarea 算正在输入', () => {
    const input = document.createElement('input');
    const textarea = document.createElement('textarea');
    expect(isTypingTarget(input)).toBe(true);
    expect(isTypingTarget(textarea)).toBe(true);
  });

  it('role=textbox 的内部节点也算正在输入', () => {
    const wrap = document.createElement('div');
    wrap.setAttribute('role', 'textbox');
    const span = document.createElement('span');
    wrap.appendChild(span);
    document.body.appendChild(wrap);
    expect(isTypingTarget(span)).toBe(true);
    wrap.remove();
  });

  it('普通按钮不算正在输入', () => {
    expect(isTypingTarget(document.createElement('button'))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});
