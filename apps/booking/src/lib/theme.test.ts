/**
 * 外观参数的解析（docs/13 §10.4）。
 *
 * 这一份盯的其实是**一道安全边界**：这些值最终会变成 CSS 变量，
 * 而它们来自 URL —— 也就是来自任何一个能给客人发链接的人。
 * `accent=red;}body{display:none}` 原样插进 style 属性就是一次 CSS 注入。
 *
 * 所以这里的每个用例都在问同一个问题：**塞一个不该有的值进去，会怎样？**
 * 正确答案永远是「安静地回到默认值」——
 * 不是报错（报错也没人看），更不是原样透传。
 */

import { describe, it, expect } from 'vitest';
import { readLook, inkOn } from './theme';

const look = (qs: string, systemDark = false) => readLook(qs, systemDark);

describe('主题与深浅', () => {
  it('什么都不传 = 黑白、跟随系统', () => {
    expect(look('')).toMatchObject({ theme: 'mono', mode: 'light', followSystem: true });
    expect(look('', true)).toMatchObject({ mode: 'dark', followSystem: true });
  });

  it('认得出 glass', () => {
    expect(look('?theme=glass').theme).toBe('glass');
  });

  it('认不出的主题回到 mono，不报错', () => {
    expect(look('?theme=bogus').theme).toBe('mono');
    expect(look('?theme=').theme).toBe('mono');
  });

  it('⭐ 显式指定 mode 之后不再跟着系统变', () => {
    // 老板把 iframe 设成 light 是因为他的页面是白的，
    // 客人系统是深色不该把这一块变黑
    expect(look('?mode=light', true)).toMatchObject({ mode: 'light', followSystem: false });
    expect(look('?mode=dark', false)).toMatchObject({ mode: 'dark', followSystem: false });
    expect(look('?mode=bogus', true)).toMatchObject({ mode: 'dark', followSystem: true });
  });
});

describe('主色', () => {
  it('六位和三位 hex 都收，带不带 # 都行', () => {
    expect(look('?accent=1a56db').accent).toBe('#1a56db');
    expect(look('?accent=%231A56DB').accent).toBe('#1a56db');
    expect(look('?accent=fc0').accent).toBe('#fc0');
  });

  it('⭐ 不是 hex 的一律丢掉 —— 这条挡的是 CSS 注入', () => {
    for (const bad of [
      'red',
      'red;}body{display:none}',
      'var(--x)',
      'url(javascript:alert(1))',
      '#1a56db;color:red',
      '12345',            // 五位，不是合法长度
      '1a56dbb',          // 七位
      '',
    ]) {
      expect(look(`?accent=${encodeURIComponent(bad)}`).accent).toBeNull();
    }
  });

  it('⭐ 按亮度自动配字色 —— 黄底白字是看不见的', () => {
    expect(inkOn('#ffd400')).toBe('#0b0b0b');   // 亮 → 深字
    expect(inkOn('#ffffff')).toBe('#0b0b0b');
    expect(inkOn('#0b2545')).toBe('#ffffff');   // 暗 → 白字
    expect(inkOn('#000000')).toBe('#ffffff');
    expect(inkOn('#fc0')).toBe('#0b0b0b');      // 三位缩写也要认
  });

  it('给了主色就一起给出配套的字色', () => {
    expect(look('?accent=ffd400')).toMatchObject({ accent: '#ffd400', accentInk: '#0b0b0b' });
    expect(look('?accent=zzz').accentInk).toBeNull();
  });
});

describe('数值参数', () => {
  it('圆角夹在 0–28', () => {
    expect(look('?radius=0').radius).toBe(0);
    expect(look('?radius=14').radius).toBe(14);
    expect(look('?radius=999').radius).toBe(28);
    expect(look('?radius=-5').radius).toBe(0);
    expect(look('?radius=abc').radius).toBeNull();
    expect(look('').radius).toBeNull();
  });

  it('宽度夹在 320–900', () => {
    expect(look('?width=420').maxWidth).toBe(420);
    expect(look('?width=99999').maxWidth).toBe(900);
    expect(look('?width=10').maxWidth).toBe(320);
  });
});

describe('开关', () => {
  it('header=0 才隐藏，别的值一律显示', () => {
    expect(look('?header=0').showHeader).toBe(false);
    expect(look('?header=1').showHeader).toBe(true);
    expect(look('?header=false').showHeader).toBe(true);   // 只认 '0'
    expect(look('').showHeader).toBe(true);
  });

  it('density 只认 compact', () => {
    expect(look('?density=compact').density).toBe('compact');
    expect(look('?density=tiny').density).toBe('normal');
  });
});
