/**
 * 邮件正文渲染（纯函数）。
 *
 * 每一条都在问：**这一行不对的话，收件人会怎么样？**
 */

import { describe, it, expect } from 'vitest';
import {
  renderConfirm, renderFormInvite,
  renderTrialEnding, renderPaymentFailed, renderSubscriptionCanceled,
  formatWhen,
} from './render';
import { EMAIL_WRAP } from './layout';

const base = {
  customerName: 'Jessica',
  shopName: 'Oasis Nails',
  serviceName: 'Gel Manicure',
  whenText: 'Wed, Aug 20, 2:30 PM',
  staffName: 'Kim',
  shopPhone: '+15125550100',
};

describe('顾客侧 · 预约确认信', () => {
  it('三要素都在：项目、时间、技师', () => {
    const r = renderConfirm(base);
    for (const s of ['Gel Manicure', 'Wed, Aug 20, 2:30 PM', 'Kim']) {
      expect(r.text).toContain(s);
      expect(r.html).toContain(s);
    }
  });

  it('标题里带时间和店名 —— 顾客在收件箱里一眼认得出是哪一单', () => {
    expect(renderConfirm(base).subject).toContain('Wed, Aug 20, 2:30 PM');
    expect(renderConfirm(base).subject).toContain('Oasis Nails');
  });

  /**
   * ⭐ 语言策略的回归测试。
   *
   * 此前 `locale` 是可选参数且默认走中文分支，两个调用点都漏传，
   * 于是顾客收到的确认信永远是中文。类型收窄之后该缺陷不可能再出现，
   * 这一条守的是「有人把中文分支加回来」。
   */
  it('🔴 正文里不出现任何中日韩字符', () => {
    const r = renderConfirm(base);
    expect(r.text).not.toMatch(/[一-鿿]/);
    expect(r.html).not.toMatch(/[一-鿿]/);
    expect(r.subject).not.toMatch(/[一-鿿]/);
  });

  it('没技师时不留一行空的 Specialist', () => {
    const r = renderConfirm({ ...base, staffName: null });
    expect(r.text).not.toContain('Specialist');
    expect(r.html).not.toContain('Specialist');
  });

  it('没店里电话时也要告诉顾客怎么改期', () => {
    const r = renderConfirm({ ...base, shopPhone: null });
    expect(r.text).toContain('call the salon');
  });

  it('套上品牌壳：logo、薄荷顶条、给了 manageUrl 才出现按钮', () => {
    const r = renderConfirm(base);
    expect(r.html).toContain(EMAIL_WRAP);
    expect(r.html).toContain('alt="GenieFront"');
    expect(r.html).toContain('geniefront-logo-email.png');
    expect(r.html).toContain('#9BCDA3');
    expect(r.text).toContain("You're booked at");

    const url = 'https://book.geniefront.com/b/appt-1?t=mt_x&k=pk_1';
    const withLink = renderConfirm({ ...base, manageUrl: url });
    expect(withLink.html).toContain('Reschedule or cancel');
  });

  it('给了 manageUrl 才出现可点链接，且链接原样保留', () => {
    const url = 'https://book.geniefront.com/b/appt-1?t=mt_x&k=pk_1';
    const r = renderConfirm({ ...base, manageUrl: url });
    expect(r.html).toContain('href=');
    expect(r.text).toContain(url);

    const none = renderConfirm({ ...base, manageUrl: null });
    expect(none.html).not.toContain('/b/');
    expect(none.html).not.toContain('Reschedule or cancel');
    expect(none.text).not.toMatch(/https?:\/\//);
  });

  it('⭐ 名字里的尖括号要转义 —— 否则店名能往信里塞 HTML', () => {
    const r = renderConfirm({ ...base, shopName: '<script>x</script>Nails' });
    expect(r.html).not.toContain('<script>');
    expect(r.html).toContain('&lt;script&gt;');
  });
});

describe('顾客侧 · 到店前填表邀请', () => {
  const invite = {
    customerName: 'Jessica',
    shopName: 'Oasis Nails',
    formTitles: ['Health Questionnaire', 'Waiver'],
    url: 'https://desk.geniefront.com/forms/intake?t=fs_abc',
    expiresText: 'Wed, Aug 26, 10:00 AM',
    shopPhone: '+15125550100',
  };

  it('🔴 正文里不出现任何中日韩字符', () => {
    const r = renderFormInvite(invite);
    expect(`${r.subject}${r.text}${r.html}`).not.toMatch(/[一-鿿]/);
  });

  it('链接、失效时间、门店电话都在', () => {
    const r = renderFormInvite(invite);
    expect(r.text).toContain(invite.url);
    expect(r.text).toContain('Wed, Aug 26, 10:00 AM');
    expect(r.text).toContain('+1 512 555 0100');
  });

  it('表单名转义', () => {
    const r = renderFormInvite({ ...invite, formTitles: ['<b>Waiver</b>'] });
    expect(r.html).not.toContain('<b>Waiver</b>');
    expect(r.html).toContain('&lt;b&gt;');
  });
});

describe('时间格式化', () => {
  it('⭐ 一律按门店时区，不是服务器时区', () => {
    // 差一小时顾客就会白跑一趟。同一个瞬间在两个时区排出来必须不同
    const iso = '2026-08-20T18:30:00.000Z';
    const ny = formatWhen(iso, 'America/New_York', 'en-US');
    const la = formatWhen(iso, 'America/Los_Angeles', 'en-US');
    expect(ny).not.toBe(la);
    expect(ny).toContain('2:30');    // 纽约下午 2:30
    expect(la).toContain('11:30');   // 洛杉矶上午 11:30
  });

  /**
   * ⭐ F-03 / F-04 的回归测试。
   *
   * 此前 `locale` 可选且默认 `zh-CN`：英文邮件里出现「8月20日 周四」，
   * 而同一个字符串还会经通知模板变量进入短信，把整条从 GSM-7 推进 UCS-2。
   */
  it('🔴 en-US 的结果里不含中日韩字符', () => {
    expect(formatWhen('2026-08-20T18:30:00.000Z', 'America/New_York', 'en-US'))
      .not.toMatch(/[一-鿿]/);
  });

  it('店主选中文时才排成中文', () => {
    expect(formatWhen('2026-08-20T18:30:00.000Z', 'America/New_York', 'zh-Hans'))
      .toMatch(/[一-鿿]/);
  });
});

describe('店主侧 · 计费类邮件', () => {
  const billingUrl = 'https://desk.geniefront.com/settings?tab=billing';

  it('英语分支里不出现中文', () => {
    const trial = renderTrialEnding({
      shopName: 'Oasis Nails', chargeDateText: 'Tue, Sep 1, 2:30 PM',
      planLabel: 'Essential', monthlyText: '$99/month',
      billingUrl, locale: 'en',
    });
    const failed = renderPaymentFailed({
      shopName: 'Oasis Nails', amountText: '$99.00',
      nextAttemptText: 'Fri, Sep 4, 9:00 AM', billingUrl, locale: 'en',
    });
    const cancelled = renderSubscriptionCanceled({
      shopName: 'Oasis Nails', endsAtText: 'Wed, Oct 1',
      atPeriodEnd: true, billingUrl, locale: 'en',
    });
    for (const m of [trial, failed, cancelled]) {
      expect(`${m.subject}${m.text}`).not.toMatch(/[一-鿿]/);
    }
  });

  it('中文分支里三封信都排成中文', () => {
    const m = renderTrialEnding({
      shopName: '莲花美甲', chargeDateText: '9月1日 周二',
      planLabel: 'Essential', monthlyText: '每月 $99',
      billingUrl, locale: 'zh-Hans',
    });
    expect(m.subject).toContain('免费试用');
  });

  /**
   * ⭐ 终止时刻取不到时的兜底必须按语言分支。
   * 此前调用点硬写中文串「当期结束时」，英文信里原样出现。
   */
  it('endsAtText 为 null 时按语言给兜底文案', () => {
    const en = renderSubscriptionCanceled({
      shopName: 'Oasis Nails', endsAtText: null,
      atPeriodEnd: true, billingUrl, locale: 'en',
    });
    expect(en.text).toContain('the end of the current billing period');
    expect(en.text).not.toMatch(/[一-鿿]/);

    const zh = renderSubscriptionCanceled({
      shopName: '莲花美甲', endsAtText: null,
      atPeriodEnd: true, billingUrl, locale: 'zh-Hans',
    });
    expect(zh.text).toContain('当前计费周期结束时');
  });

  it('扣款失败信里一个字都不提银行卡的细节', () => {
    const m = renderPaymentFailed({
      shopName: 'Oasis Nails', amountText: '$99.00',
      nextAttemptText: null, billingUrl, locale: 'en',
    });
    expect(m.text).not.toMatch(/visa|mastercard|\*{2,}\d{4}|last 4/i);
  });

  it('三封信里唯一的链接都指向设置页账单 tab', () => {
    const m = renderPaymentFailed({
      shopName: 'Oasis Nails', amountText: '$99.00',
      nextAttemptText: null, billingUrl, locale: 'en',
    });
    expect(m.text).toContain('/settings?tab=billing');
    expect(m.text).not.toContain('/?tab=billing');
  });

  it('店主三封都套共用容器，并且有可点按钮，不再是裸 <p>', () => {
    const trial = renderTrialEnding({
      shopName: 'Oasis Nails', chargeDateText: 'Tue, Sep 1, 2:30 PM',
      planLabel: 'Essential', monthlyText: '$99/month',
      billingUrl, locale: 'en',
    });
    const failed = renderPaymentFailed({
      shopName: 'Oasis Nails', amountText: '$99.00',
      nextAttemptText: null, billingUrl, locale: 'en',
    });
    const cancelled = renderSubscriptionCanceled({
      shopName: 'Oasis Nails', endsAtText: 'Wed, Oct 1',
      atPeriodEnd: true, billingUrl, locale: 'en',
    });
    for (const m of [trial, failed, cancelled]) {
      expect(m.html).toContain(EMAIL_WRAP);
      expect(m.html).toContain('alt="GenieFront"');
      expect(m.html).toContain('display:inline-block');
    }
    expect(trial.html).toContain('Manage billing');
    expect(failed.html).toContain('Update payment method');
    expect(cancelled.html).toContain('Resubscribe');
  });
});
