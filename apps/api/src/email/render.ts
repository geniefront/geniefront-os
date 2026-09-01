/**
 * 邮件正文渲染。**纯函数** —— 不查库、不看时钟。
 *
 * ⭐ 渲染发生在**写 outbox 那一刻**（业务事务里），不是发的时候。
 * 发的时候数据可能已经变了（预约被改期），那样发出去的内容和
 * 「当时发生了什么」对不上；而且事后想查一封信到底写了什么也无从查起。
 * outbox 那一行**就是那封信本身**。
 */

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
   .replace(/"/g, '&quot;');

export interface ConfirmData {
  customerName: string;
  shopName: string;
  serviceName: string;
  /** 已经按门店时区格式化好的，如「8月20日 周三 下午 2:30」 */
  whenText: string;
  staffName: string | null;
  shopPhone: string | null;
  /**
   * 自助改期 / 取消的链接。**null = 不放**（批 2）。
   *
   * 只在客人留了手机号时才有值 —— 链接打开后要验手机后四位，
   * 没留号码就验不了，那时令牌又变回单因素凭证（见下面的长注释）。
   */
  manageUrl?: string | null;
  locale?: string;
}

export interface Rendered { subject: string; html: string; text: string; }

/**
 * 预约确认信（支持中英多语言，默认优先英语/按语言适配）。
 */
export function renderConfirm(d: ConfirmData): Rendered {
  const isEn = d.locale?.startsWith('en');

  if (isEn) {
    // English template
    const who = d.staffName ? `Specialist: ${d.staffName}` : '';
    const call = d.manageUrl
      ? [
          `Reschedule or cancel: ${d.manageUrl}`,
          '(Enter the last 4 digits of your phone number)',
          d.shopPhone ? `Or call us at ${d.shopPhone}.` : 'Or call the store.',
        ].join('\n')
      : (d.shopPhone ? `To reschedule or cancel, please call ${d.shopPhone}.` : 'To reschedule or cancel, please call the store.');

    const text = [
      `Hi ${d.customerName},`,
      ``,
      `Your appointment at ${d.shopName} has been confirmed:`,
      ``,
      `  Service: ${d.serviceName}`,
      `  Time: ${d.whenText}`,
      ...(who ? [`  ${who}`] : []),
      ``,
      call,
      ``,
      `— ${d.shopName}`,
    ].join('\n');

    const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:16px;line-height:1.7;color:#211e1b;max-width:520px">
<p>Hi ${esc(d.customerName)},</p>
<p>Your appointment at <strong>${esc(d.shopName)}</strong> is confirmed:</p>
<table style="border-collapse:collapse;margin:16px 0">
<tr><td style="padding:4px 16px 4px 0;color:#6b635a">Service</td><td><strong>${esc(d.serviceName)}</strong></td></tr>
<tr><td style="padding:4px 16px 4px 0;color:#6b635a">Time</td><td><strong>${esc(d.whenText)}</strong></td></tr>
${d.staffName ? `<tr><td style="padding:4px 16px 4px 0;color:#6b635a">Specialist</td><td>${esc(d.staffName)}</td></tr>` : ''}
</table>
${d.manageUrl ? `<p style="font-size:15px"><a href="${esc(d.manageUrl)}" style="color:#0f5f57">Reschedule or Cancel</a>
<span style="color:#6b635a;font-size:13px">(Enter last 4 digits of your phone)</span></p>
<p style="color:#6b635a;font-size:14px">${d.shopPhone ? `Or call ${esc(d.shopPhone)}.` : 'Or call the store.'}</p>`
  : `<p style="color:#6b635a;font-size:14px">${esc(call)}</p>`}
<p style="color:#6b635a;font-size:14px">— ${esc(d.shopName)}</p>
</div>`;

    return { subject: `Appointment Confirmed · ${d.whenText} · ${d.shopName}`, html, text };
  }

  // 默认中文模板 (Default Chinese)
  const who = d.staffName ? `技师：${d.staffName}` : '';
  const call = d.manageUrl
    ? [
        `改期或取消：${d.manageUrl}`,
        '（打开后需要输入你手机号的后四位）',
        d.shopPhone ? `或致电 ${d.shopPhone}。` : '或致电门店。',
      ].join('\n')
    : (d.shopPhone ? `如需改期或取消，请致电 ${d.shopPhone}。` : '如需改期或取消，请致电门店。');

  const text = [
    `${d.customerName} 您好，`,
    ``,
    `您在 ${d.shopName} 的预约已确认：`,
    ``,
    `  项目：${d.serviceName}`,
    `  时间：${d.whenText}`,
    ...(who ? [`  ${who}`] : []),
    ``,
    call,
    ``,
    `— ${d.shopName}`,
  ].join('\n');

  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:16px;line-height:1.7;color:#211e1b;max-width:520px">
<p>${esc(d.customerName)} 您好，</p>
<p>您在 <strong>${esc(d.shopName)}</strong> 的预约已确认：</p>
<table style="border-collapse:collapse;margin:16px 0">
<tr><td style="padding:4px 16px 4px 0;color:#6b635a">项目</td><td><strong>${esc(d.serviceName)}</strong></td></tr>
<tr><td style="padding:4px 16px 4px 0;color:#6b635a">时间</td><td><strong>${esc(d.whenText)}</strong></td></tr>
${d.staffName ? `<tr><td style="padding:4px 16px 4px 0;color:#6b635a">技师</td><td>${esc(d.staffName)}</td></tr>` : ''}
</table>
${d.manageUrl ? `<p style="font-size:15px"><a href="${esc(d.manageUrl)}" style="color:#0f5f57">改期或取消</a>
<span style="color:#6b635a;font-size:13px">（打开后需要输入你手机号的后四位）</span></p>
<p style="color:#6b635a;font-size:14px">${d.shopPhone ? `或致电 ${esc(d.shopPhone)}。` : '或致电门店。'}</p>`
  : `<p style="color:#6b635a;font-size:14px">${esc(call)}</p>`}
<p style="color:#6b635a;font-size:14px">— ${esc(d.shopName)}</p>
</div>`;

  return { subject: `预约已确认 · ${d.whenText} · ${d.shopName}`, html, text };
}

export interface FormInviteData {
  customerName: string;
  shopName: string;
  /** 要签的表叫什么（已经按客人语言取好） */
  formTitles: string[];
  url: string;
  /** 已按门店时区格式化好的失效时间 */
  expiresText: string;
  shopPhone: string | null;
  locale?: string;
}

export function renderFormInvite(d: FormInviteData): Rendered {
  const isEn = d.locale?.startsWith('en');
  const list = d.formTitles.join(isEn ? ', ' : '、');

  if (isEn) {
    // 英语邀请
    const call = d.shopPhone
      ? `If you have questions, please call ${d.shopPhone} or complete it at our front desk upon arrival.`
      : 'If you have questions, please call us or complete it at our front desk upon arrival.';

    const text = [
      `Hi ${d.customerName},`,
      ``,
      `${d.shopName} invites you to take two minutes to complete your ${list} before your visit.`,
      ``,
      `  ${d.url}`,
      ``,
      `This link is valid until ${d.expiresText} and will expire once submitted.`,
      call,
      ``,
      `— ${d.shopName}`,
    ].join('\n');

    const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:16px;line-height:1.7;color:#211e1b;max-width:520px">
<p>Hi ${esc(d.customerName)},</p>
<p><strong>${esc(d.shopName)}</strong> invites you to take two minutes to complete your ${esc(list)} before your visit.</p>
<p style="margin:24px 0">
  <a href="${esc(d.url)}" style="display:inline-block;background:#0f0f0f;color:#fff;text-decoration:none;padding:14px 28px;border-radius:10px;font-weight:600">Fill Out Form</a>
</p>
<p style="color:#6b635a;font-size:14px">Link is valid until ${esc(d.expiresText)}.</p>
<p style="color:#6b635a;font-size:14px">— ${esc(d.shopName)}</p>
</div>`;

    return { subject: `Please complete intake form before your visit · ${d.shopName}`, html, text };
  }

  // 默认中文
  const call = d.shopPhone
    ? `有问题请致电 ${d.shopPhone}，也可以到店后在前台填。`
    : '有问题请致电门店，也可以到店后在前台填。';

  const text = [
    `${d.customerName} 您好，`,
    ``,
    `${d.shopName} 请您在到店前花两分钟填一份${list}。`,
    `到店当天就不用在柜台前填了。`,
    ``,
    `  ${d.url}`,
    ``,
    `这个链接 ${d.expiresText} 之前有效，填完即失效。`,
    call,
    ``,
    `— ${d.shopName}`,
  ].join('\n');

  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:16px;line-height:1.7;color:#211e1b;max-width:520px">
<p>${esc(d.customerName)} 您好，</p>
<p><strong>${esc(d.shopName)}</strong> 请您在到店前花两分钟填一份${esc(list)}。到店当天就不用在柜台前填了。</p>
<p style="margin:24px 0">
  <a href="${esc(d.url)}" style="display:inline-block;background:#0f0f0f;color:#fff;text-decoration:none;padding:14px 28px;border-radius:10px;font-weight:600">开始填写</a>
</p>
<p style="color:#6b635a;font-size:14px">链接 ${esc(d.expiresText)} 之前有效，填完即失效。</p>
<p style="color:#6b635a;font-size:14px">— ${esc(d.shopName)}</p>
</div>`;

  return { subject: `请在到店前填写${list} · ${d.shopName}`, html, text };
}

/**
 * 把 UTC 时间按门店时区排成人话。
 */
export function formatWhen(iso: string, timezone: string, locale?: string): string {
  const d = new Date(iso);
  const targetLocale = locale || 'zh-CN';
  const date = new Intl.DateTimeFormat(targetLocale, {
    timeZone: timezone, month: 'short', day: 'numeric', weekday: 'short',
  }).format(d);
  const time = new Intl.DateTimeFormat(targetLocale, {
    timeZone: timezone, hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(d);
  return `${date} ${time}`;
}

// ─────────────────────────────────────────────────────── 试用还有 3 天到期

export interface TrialEndingData {
  shopName: string;
  /** 已经按门店时区格式化好的首次扣款日，如「9月1日 周二」 */
  chargeDateText: string;
  planLabel: string;
  monthlyText: string;
  /** 老板自助管理订阅的入口（Stripe Customer Portal 的落地页） */
  billingUrl: string;
  locale?: string;
}

export function renderTrialEnding(d: TrialEndingData): Rendered {
  const isZh = d.locale?.startsWith('zh');

  if (isZh) {
    const text = [
      `${d.shopName}：免费试用还有 3 天`,
      '',
      `首次扣款：${d.chargeDateText}`,
      `套餐：${d.planLabel}，${d.monthlyText}`,
      '',
      '什么都不用做，到期会自动续。',
      `想改套餐或取消，在这里操作：${d.billingUrl}`,
      '取消后当前试用期照常用到最后一天，不会补扣。',
    ].join('\n');

    const html = [
      `<p>${esc(d.shopName)}：免费试用还有 3 天。</p>`,
      `<p><strong>首次扣款：${esc(d.chargeDateText)}</strong><br>`,
      `套餐：${esc(d.planLabel)}，${esc(d.monthlyText)}</p>`,
      '<p>什么都不用做，到期会自动续。</p>',
      `<p>想改套餐或取消：<a href="${esc(d.billingUrl)}">${esc(d.billingUrl)}</a><br>`,
      '取消后当前试用期照常用到最后一天，不会补扣。</p>',
    ].join('\n');

    return { subject: `${d.shopName}：免费试用还有 3 天`, html, text };
  }

  // 默认英语
  const text = [
    `${d.shopName}: 3 days left in your free trial`,
    '',
    `First charge date: ${d.chargeDateText}`,
    `Plan: ${d.planLabel}, ${d.monthlyText}`,
    '',
    'No action needed, your subscription will automatically continue.',
    `To manage your plan or cancel: ${d.billingUrl}`,
    'If cancelled, your trial remains active until the last day with no unexpected charges.',
  ].join('\n');

  const html = [
    `<p>${esc(d.shopName)}: 3 days left in your free trial.</p>`,
    `<p><strong>First charge date: ${esc(d.chargeDateText)}</strong><br>`,
    `Plan: ${esc(d.planLabel)}, ${esc(d.monthlyText)}</p>`,
    '<p>No action needed, your subscription will automatically continue.</p>',
    `<p>Manage or cancel: <a href="${esc(d.billingUrl)}">${esc(d.billingUrl)}</a><br>`,
    'If cancelled, your trial remains active until the last day with no unexpected charges.</p>',
  ].join('\n');

  return { subject: `${d.shopName}: 3 days left in your free trial`, html, text };
}

// ───────────────────────────────────────────────────────────── 扣款失败

export interface PaymentFailedData {
  shopName: string;
  /** 这次没扣上多少钱，已经格式化好，如「$99.00」 */
  amountText: string;
  /** 已经按门店时区格式化好的下次自动重试时间。null = 不再自动重试 */
  nextAttemptText: string | null;
  /** 老板自助更新支付方式的入口（Stripe Customer Portal 的落地页） */
  billingUrl: string;
  locale?: string;
}

/**
 * 扣款失败通知。
 *
 * ⭐ 这封信是**必须有**的：扣款失败之后 Stripe 会把订阅带成 `past_due`，
 * 而我们据此冻结全店写入。没有这封信的话，老板得到的唯一信号是
 * 第二天早上前台开不了单 —— 而那时候他既不知道为什么，也不知道该做什么。
 *
 * ⚠️ 信里**不写卡的任何信息**（品牌、后四位、失败码都不写）。
 * 邮件会被转发、会被截图；而「去更新支付方式」这一个动作已经足够。
 */
export function renderPaymentFailed(d: PaymentFailedData): Rendered {
  const isZh = d.locale?.startsWith('zh');

  if (isZh) {
    const retry = d.nextAttemptText
      ? `我们会在 ${d.nextAttemptText} 自动再试一次。`
      : '这是最后一次尝试，需要你手动处理。';
    const text = [
      `${d.shopName}：订阅扣款失败`,
      '',
      `金额：${d.amountText}`,
      retry,
      '',
      `请更新支付方式：${d.billingUrl}`,
      '',
      '⚠️ 在扣款成功之前，这家店只能查看数据，不能开单、不能改预约。',
    ].join('\n');

    const html = [
      `<p><strong>${esc(d.shopName)}：订阅扣款失败。</strong></p>`,
      `<p>金额：${esc(d.amountText)}<br>${esc(retry)}</p>`,
      `<p>请更新支付方式：<a href="${esc(d.billingUrl)}">${esc(d.billingUrl)}</a></p>`,
      '<p>⚠️ 在扣款成功之前，这家店只能查看数据，不能开单、不能改预约。</p>',
    ].join('\n');

    return { subject: `${d.shopName}：订阅扣款失败，请更新支付方式`, html, text };
  }

  const retry = d.nextAttemptText
    ? `We will automatically retry on ${d.nextAttemptText}.`
    : 'This was the final attempt — please update your card to continue.';
  const text = [
    `${d.shopName}: subscription payment failed`,
    '',
    `Amount: ${d.amountText}`,
    retry,
    '',
    `Update your payment method: ${d.billingUrl}`,
    '',
    'Until payment succeeds this location is read-only: no new tickets, no booking changes.',
  ].join('\n');

  const html = [
    `<p><strong>${esc(d.shopName)}: subscription payment failed.</strong></p>`,
    `<p>Amount: ${esc(d.amountText)}<br>${esc(retry)}</p>`,
    `<p>Update your payment method: <a href="${esc(d.billingUrl)}">${esc(d.billingUrl)}</a></p>`,
    '<p>Until payment succeeds this location is read-only: '
      + 'no new tickets, no booking changes.</p>',
  ].join('\n');

  return { subject: `${d.shopName}: payment failed — update your card`, html, text };
}

// ───────────────────────────────────────────────────────────── 订阅已取消

export interface SubscriptionCanceledData {
  shopName: string;
  /** 已经按门店时区格式化好的服务终止时刻 */
  endsAtText: string;
  /** true = 期末取消，当前周期还能用完；false = 已经立即终止 */
  atPeriodEnd: boolean;
  billingUrl: string;
  locale?: string;
}

/**
 * 退订确认信。
 *
 * ⭐ 期末取消时**必须发**：老板点完取消，界面上这家店还能正常用，
 * 他很容易以为没点成功而再点一次（或者打电话来问）。这封信是唯一
 * 说清「什么时候真的停」的地方。
 */
export function renderSubscriptionCanceled(d: SubscriptionCanceledData): Rendered {
  const isZh = d.locale?.startsWith('zh');

  if (isZh) {
    const when = d.atPeriodEnd
      ? `当前计费周期结束（${d.endsAtText}）之前一切照常，之后这家店转为只读。`
      : `订阅已于 ${d.endsAtText} 终止，这家店现在是只读状态。`;
    const text = [
      `${d.shopName}：订阅已取消`,
      '',
      when,
      '',
      '数据不会被删除，随时可以恢复订阅：',
      d.billingUrl,
    ].join('\n');

    const html = [
      `<p><strong>${esc(d.shopName)}：订阅已取消。</strong></p>`,
      `<p>${esc(when)}</p>`,
      `<p>数据不会被删除，随时可以恢复订阅：`
        + `<a href="${esc(d.billingUrl)}">${esc(d.billingUrl)}</a></p>`,
    ].join('\n');

    return { subject: `${d.shopName}：订阅已取消`, html, text };
  }

  const when = d.atPeriodEnd
    ? `Everything keeps working until the end of the current billing period (${d.endsAtText}), `
      + 'after which this location becomes read-only.'
    : `The subscription ended on ${d.endsAtText}; this location is now read-only.`;
  const text = [
    `${d.shopName}: subscription cancelled`,
    '',
    when,
    '',
    'Your data is kept. You can resubscribe at any time:',
    d.billingUrl,
  ].join('\n');

  const html = [
    `<p><strong>${esc(d.shopName)}: subscription cancelled.</strong></p>`,
    `<p>${esc(when)}</p>`,
    `<p>Your data is kept. You can resubscribe at any time: `
      + `<a href="${esc(d.billingUrl)}">${esc(d.billingUrl)}</a></p>`,
  ].join('\n');

  return { subject: `${d.shopName}: subscription cancelled`, html, text };
}
