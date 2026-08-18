/**
 * 邮件正文渲染（纯函数）。
 *
 * 每一条都在问：**这一行不对的话，客人会怎么样？**
 */

import { describe, it, expect } from 'vitest';
import { renderConfirm, formatWhen } from './render';

const base = {
  customerName: 'Jessica',
  shopName: 'Oasis Nails',
  serviceName: '光疗美甲',
  whenText: '8月20日 周三 下午2:30',
  staffName: 'Kim',
  shopPhone: '+15125550100',
};

describe('预约确认信', () => {
  it('三要素都在：项目、时间、技师', () => {
    const r = renderConfirm(base);
    for (const s of ['光疗美甲', '8月20日 周三 下午2:30', 'Kim']) {
      expect(r.text).toContain(s);
      expect(r.html).toContain(s);
    }
  });

  it('标题里带时间和店名 —— 客人收件箱里一眼认得出是哪一单', () => {
    expect(renderConfirm(base).subject).toContain('8月20日 周三 下午2:30');
    expect(renderConfirm(base).subject).toContain('Oasis Nails');
  });

  it('⭐ 不放取消/改期链接', () => {
    // 那需要一个无登录的公开入口，而「捡到这个链接的人能干什么」
    // 的答案会是「改掉别人的预约」。让客人打电话给店里 ——
    // 这也正是店家想要的（有机会挽留）
    const r = renderConfirm(base);
    expect(r.html).not.toMatch(/href=/);
    expect(r.text).not.toMatch(/https?:\/\//);
  });

  it('没技师时不留一行空的「技师：」', () => {
    const r = renderConfirm({ ...base, staffName: null });
    expect(r.text).not.toContain('技师：');
    expect(r.html).not.toContain('技师');
  });

  it('没店里电话时也要告诉客人怎么改期', () => {
    const r = renderConfirm({ ...base, shopPhone: null });
    expect(r.text).toContain('致电门店');
  });

  it('⭐ 名字里的尖括号要转义 —— 否则店名能往信里塞 HTML', () => {
    const r = renderConfirm({ ...base, shopName: '<script>x</script>Nails' });
    expect(r.html).not.toContain('<script>');
    expect(r.html).toContain('&lt;script&gt;');
  });
});

describe('时间格式化', () => {
  it('⭐ 一律按门店时区，不是服务器时区', () => {
    // 差一小时客人就会白跑一趟。同一个瞬间在两个时区排出来必须不同
    const iso = '2026-08-20T18:30:00.000Z';
    const ny = formatWhen(iso, 'America/New_York');
    const la = formatWhen(iso, 'America/Los_Angeles');
    expect(ny).not.toBe(la);
    expect(ny).toContain('2:30');    // 纽约下午 2:30
    expect(la).toContain('11:30');   // 洛杉矶上午 11:30
  });
});
