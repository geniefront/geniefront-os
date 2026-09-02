import { describe, expect, it } from 'vitest';
import {
  EMAIL_WRAP, escapeHtml, nl2brHtml, renderMarketingEmail,
  renderTemplatedEmailHtml, wrapEmailHtml,
} from './layout';

describe('邮件共用排版', () => {
  it('wrap 带上品牌壳：logo、顶条、白卡片', () => {
    const html = wrapEmailHtml('<p>Hi</p>');
    expect(html).toContain(EMAIL_WRAP);
    expect(html).toContain('<p>Hi</p>');
    expect(html).toContain('alt="GenieFront"');
    expect(html).toContain('geniefront-logo-email.png');
    expect(html).toContain('#9BCDA3');
    expect(html).toContain('600');
  });

  it('店主模板里的尖括号必须转义 —— 否则店名能往信里塞 HTML', () => {
    expect(escapeHtml('<script>x</script>')).toBe('&lt;script&gt;x&lt;/script&gt;');
    expect(nl2brHtml('a\n<b>')).toBe('a<br>&lt;b&gt;');
  });

  it('事务性路径 B 套容器、没有退订页脚', () => {
    const html = renderTemplatedEmailHtml('Hi Jane,\nSee you at 2pm.');
    expect(html).toContain(EMAIL_WRAP);
    expect(html).toContain('<br>');
    expect(html).not.toContain('Unsubscribe');
  });

  it('营销信套容器、保留换行、退订链接可用', () => {
    const { html, text } = renderMarketingEmail(
      'Hi Jane,\n\nHappy birthday from <Lotus>.',
      'https://desk.geniefront.com/unsubscribe?t=abc',
    );
    expect(html).toContain(EMAIL_WRAP);
    expect(html).toContain('<br>');
    expect(html).not.toContain('<Lotus>');
    expect(html).toContain('&lt;Lotus&gt;');
    expect(html).toContain('href="https://desk.geniefront.com/unsubscribe?t=abc"');
    expect(html).toContain('Unsubscribe');
    expect(text).toContain('Happy birthday from <Lotus>.');
    expect(text).toContain('https://desk.geniefront.com/unsubscribe?t=abc');
  });
});
