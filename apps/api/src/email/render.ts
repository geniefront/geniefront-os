/**
 * 邮件正文渲染。**纯函数** —— 不查库、不看时钟。
 *
 * ⭐ 渲染发生在**写 outbox 那一刻**（业务事务内），而非投递时。
 * 投递时数据可能已经变更（例如预约被改期），此时发出的内容与
 * 「当时发生了什么」不符；且事后无从查证某一封信的实际内容。
 * outbox 中的那一行**即是该邮件本身**。
 *
 * ## ⭐ 语言策略（2026-09-01 店主确认）
 *
 * | 收件人 | 语言 |
 * | :--- | :--- |
 * | **顾客** | **恒为英语。** 不跟随顾客档案、不跟随操作员界面语言 |
 * | **店主**（计费类） | 默认英语，按 `organizations.default_locale` 切换 |
 * | 顾客短信 | 恒为英语（`sms/render.ts`） |
 *
 * ⚠️ 因此面向顾客的模板**不再保留多语言分支**。此前的实现保留了中文分支，
 * 而调用点遗漏 `locale` 参数时会静默落入该分支 —— 缺陷表现为「顾客收到
 * 中文邮件」，无任何报错。删除分支使该类缺陷在类型层面即不可能出现。
 */

import type { OwnerLocale } from './locale';
import { isZhLocale, intlLocale } from './locale';
import {
  EMAIL_MUTED,
  emailButton,
  emailDetailTable,
  emailHeading,
  escapeHtml as esc,
  wrapEmailHtml,
} from './layout';

export interface Rendered { subject: string; html: string; text: string; }

const muted = (s: string) => `<p style="${EMAIL_MUTED}">${s}</p>`;

// ═══════════════════════════════════════════════════ 顾客侧 · 预约确认

export interface ConfirmData {
  customerName: string;
  shopName: string;
  serviceName: string;
  /** 已按门店时区格式化好的英文时间，如 `Wed, Aug 26, 12:30 PM` */
  whenText: string;
  staffName: string | null;
  shopPhone: string | null;
  /**
   * 自助改期 / 取消链接。**null = 不放**。
   *
   * 仅在顾客留有手机号时才有值 —— 链接打开后需校验手机号后四位，
   * 未留号码则无法完成校验，此时令牌将退化为单因素凭证。
   *
   * ⚠️ 必须由 `links.ts` 的 `manageBookingUrl()` 构造：该函数保证 origin
   * 指向对外预约页并携带门店 public_key，缺其一则页面无法调用公开 API。
   */
  manageUrl?: string | null;
}

/**
 * 预约确认信。**仅英语**（见文件头语言策略）。
 */
export function renderConfirm(d: ConfirmData): Rendered {
  const who = d.staffName ? `Specialist: ${d.staffName}` : '';
  const call = d.manageUrl
    ? [
        `Reschedule or cancel: ${d.manageUrl}`,
        '(Enter the last 4 digits of your phone number)',
        d.shopPhone ? `Or call us at ${d.shopPhone}.` : 'Or call the salon.',
      ].join('\n')
    : (d.shopPhone
        ? `To reschedule or cancel, please call ${d.shopPhone}.`
        : 'To reschedule or cancel, please call the salon.');

  const text = [
    `Hi ${d.customerName},`,
    ``,
    `You're booked at ${d.shopName}.`,
    ``,
    `  Service: ${d.serviceName}`,
    `  Time: ${d.whenText}`,
    ...(who ? [`  ${who}`] : []),
    ``,
    call,
    ``,
    `See you then,`,
    `${d.shopName}`,
  ].join('\n');

  const rows: Array<readonly [string, string]> = [
    ['Service', d.serviceName],
    ['Time', d.whenText],
  ];
  if (d.staffName) rows.push(['Specialist', d.staffName]);

  const action = d.manageUrl
    ? emailButton(d.manageUrl, 'Reschedule or cancel')
      + muted('(Enter the last 4 digits of your phone)')
      + muted(d.shopPhone ? `Or call ${esc(d.shopPhone)}.` : 'Or call the salon.')
    : muted(esc(call));

  const html = wrapEmailHtml([
    emailHeading('Appointment confirmed', `You're booked at ${esc(d.shopName)}`),
    `<p style="margin:0 0 16px">Hi ${esc(d.customerName)},</p>`,
    emailDetailTable(rows),
    action,
    muted(`See you then,<br>${esc(d.shopName)}`),
  ].join('\n'), {
    preheader: `You're booked at ${d.shopName} · ${d.whenText}`,
  });

  return { subject: `Appointment confirmed · ${d.whenText} · ${d.shopName}`, html, text };
}

// ═══════════════════════════════════════════════════ 顾客侧 · 到店前填表

export interface FormInviteData {
  customerName: string;
  shopName: string;
  /** 待填表单的名称 */
  formTitles: string[];
  url: string;
  /** 已按门店时区格式化好的英文失效时间 */
  expiresText: string;
  shopPhone: string | null;
}

/** 到店前填表邀请信。**仅英语**。 */
export function renderFormInvite(d: FormInviteData): Rendered {
  const list = d.formTitles.join(', ');
  const call = d.shopPhone
    ? `Questions? Call ${d.shopPhone}, or we can help you at the front desk.`
    : 'Questions? Call us, or we can help you at the front desk.';

  const text = [
    `Hi ${d.customerName},`,
    ``,
    `${d.shopName} would like you to complete your ${list} before you arrive. It takes about two minutes.`,
    ``,
    `  ${d.url}`,
    ``,
    `This link works until ${d.expiresText}, and expires once you submit.`,
    call,
    ``,
    `— ${d.shopName}`,
  ].join('\n');

  const html = wrapEmailHtml([
    emailHeading('Before you arrive', `Complete your form for ${esc(d.shopName)}`),
    `<p style="margin:0 0 16px">Hi ${esc(d.customerName)},</p>`,
    `<p style="margin:0 0 8px">${esc(d.shopName)} would like you to complete your ${esc(list)} before you arrive. It takes about two minutes.</p>`,
    emailButton(d.url, 'Fill out form'),
    muted(`This link works until ${esc(d.expiresText)}.`),
    muted(esc(call)),
  ].join('\n'), {
    preheader: `Complete your form before your visit to ${d.shopName}`,
  });

  return { subject: `Please complete your form before your visit · ${d.shopName}`, html, text };
}

// ═══════════════════════════════════════════════════════════ 时间格式化

/**
 * 将 UTC 时刻按门店时区格式化为可读文本。
 *
 * ⚠️ `locale` 为**必填**。此前该参数可选且默认 `zh-CN`，导致英文邮件正文中
 * 出现「9月1日 周二 下午2:30」，且该结果还会经由通知模板变量进入短信，
 * 使整条短信从 GSM-7 退化为 UCS-2（每段 70 字符，计费翻倍）。
 */
export function formatWhen(iso: string, timezone: string, locale: string): string {
  const d = new Date(iso);
  const tag = intlLocale(locale);
  const date = new Intl.DateTimeFormat(tag, {
    timeZone: timezone, month: 'short', day: 'numeric', weekday: 'short',
  }).format(d);
  const time = new Intl.DateTimeFormat(tag, {
    timeZone: timezone, hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(d);
  return `${date} ${time}`;
}

// ═══════════════════════════════════════════ 店主侧 · 试用还有 3 天到期

export interface TrialEndingData {
  shopName: string;
  /** 已按门店时区与店主语言格式化好的首次扣款日 */
  chargeDateText: string;
  planLabel: string;
  monthlyText: string;
  /** 店主自助管理订阅的入口，由 `links.ts` 的 `billingPortalUrl()` 构造 */
  billingUrl: string;
  locale: OwnerLocale;
}

export function renderTrialEnding(d: TrialEndingData): Rendered {
  if (isZhLocale(d.locale)) {
    const text = [
      `${d.shopName}：免费试用还有 3 天`,
      '',
      `首次扣款：${d.chargeDateText}`,
      `套餐：${d.planLabel}，${d.monthlyText}`,
      '',
      '无需任何操作，到期将自动续订。',
      `如需变更套餐或取消，请在此处操作：${d.billingUrl}`,
      '取消后当前试用期仍可使用至最后一天，不会产生补扣。',
    ].join('\n');

    const html = wrapEmailHtml([
      emailHeading('订阅', `${esc(d.shopName)}：免费试用还有 3 天`),
      `<p>首次扣款：<strong>${esc(d.chargeDateText)}</strong><br>`,
      `套餐：${esc(d.planLabel)}，${esc(d.monthlyText)}</p>`,
      '<p>无需任何操作，到期将自动续订。</p>',
      emailButton(d.billingUrl, '管理订阅'),
      muted('取消后当前试用期仍可使用至最后一天，不会产生补扣。'),
    ].join('\n'), { variant: 'owner', zh: true });

    return { subject: `${d.shopName}：免费试用还有 3 天`, html, text };
  }

  const text = [
    `${d.shopName}: 3 days left in your free trial`,
    '',
    `First charge date: ${d.chargeDateText}`,
    `Plan: ${d.planLabel}, ${d.monthlyText}`,
    '',
    'No action needed — your subscription will continue automatically.',
    `To manage your plan or cancel: ${d.billingUrl}`,
    'If you cancel, your trial stays active until the last day. No extra charges.',
  ].join('\n');

  const html = wrapEmailHtml([
    emailHeading('Billing', `${esc(d.shopName)}: 3 days left in your free trial`),
    `<p>First charge date: <strong>${esc(d.chargeDateText)}</strong><br>`,
    `Plan: ${esc(d.planLabel)}, ${esc(d.monthlyText)}</p>`,
    '<p>No action needed — your subscription will continue automatically.</p>',
    emailButton(d.billingUrl, 'Manage billing'),
    muted('If you cancel, your trial stays active until the last day. No extra charges.'),
  ].join('\n'), { variant: 'owner' });

  return { subject: `${d.shopName}: 3 days left in your free trial`, html, text };
}

// ═══════════════════════════════════════════════════ 店主侧 · 扣款失败

export interface PaymentFailedData {
  shopName: string;
  /** 本次未扣成功的金额，已格式化，如 `$99.00` */
  amountText: string;
  /** 已格式化的下次自动重试时刻。null = 不再自动重试 */
  nextAttemptText: string | null;
  billingUrl: string;
  locale: OwnerLocale;
}

/**
 * 扣款失败通知。
 *
 * ⭐ 该通知**不可省略**：扣款失败后 Stripe 会将订阅置为 `past_due`，
 * 系统据此冻结全店写入。缺少本通知时，店主获得的唯一信号是次日前台
 * 无法开单 —— 届时其既不知原因，也不知应采取何种措施。
 *
 * ⚠️ 正文**不包含银行卡的任何信息**（卡组织、后四位、失败码均不写）。
 * 邮件存在被转发与截图的可能，而「前往更新支付方式」这一动作已足够。
 */
export function renderPaymentFailed(d: PaymentFailedData): Rendered {
  if (isZhLocale(d.locale)) {
    const retry = d.nextAttemptText
      ? `系统将于 ${d.nextAttemptText} 自动重试一次。`
      : '本次为最后一次尝试，需要您手动处理。';
    const text = [
      `${d.shopName}：订阅扣款失败`,
      '',
      `金额：${d.amountText}`,
      retry,
      '',
      `请更新支付方式：${d.billingUrl}`,
      '',
      '在扣款成功之前，本门店仅可查看数据，无法开单，也无法修改预约。',
    ].join('\n');

    const html = wrapEmailHtml([
      emailHeading('需要处理', `${esc(d.shopName)}：订阅扣款失败`),
      `<p>金额：${esc(d.amountText)}<br>${esc(retry)}</p>`,
      emailButton(d.billingUrl, '更新支付方式'),
      muted('在扣款成功之前，本门店仅可查看数据，无法开单，也无法修改预约。'),
    ].join('\n'), { variant: 'owner', zh: true });

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

  const html = wrapEmailHtml([
    emailHeading('Action required', `${esc(d.shopName)}: subscription payment failed`),
    `<p>Amount: ${esc(d.amountText)}<br>${esc(retry)}</p>`,
    emailButton(d.billingUrl, 'Update payment method'),
    muted('Until payment succeeds this location is read-only: no new tickets, no booking changes.'),
  ].join('\n'), { variant: 'owner' });

  return { subject: `${d.shopName}: payment failed — update your card`, html, text };
}

// ═══════════════════════════════════════════════════ 店主侧 · 订阅已取消

export interface SubscriptionCanceledData {
  shopName: string;
  /** 已格式化的服务终止时刻。null = 未能取到确切时刻 */
  endsAtText: string | null;
  /** true = 期末取消，当前周期仍可使用；false = 已立即终止 */
  atPeriodEnd: boolean;
  billingUrl: string;
  locale: OwnerLocale;
}

/**
 * 退订确认信。
 *
 * ⭐ 期末取消时**必须发送**：店主完成取消操作后，界面上门店仍可正常使用，
 * 易被误判为操作未生效而重复提交。本通知是唯一明确说明服务终止时刻的渠道。
 */
export function renderSubscriptionCanceled(d: SubscriptionCanceledData): Rendered {
  if (isZhLocale(d.locale)) {
    const ends = d.endsAtText ?? '当前计费周期结束时';
    const when = d.atPeriodEnd
      ? `当前计费周期结束（${ends}）之前一切照常，之后本门店转为只读状态。`
      : `订阅已于 ${ends} 终止，本门店当前为只读状态。`;
    const text = [
      `${d.shopName}：订阅已取消`,
      '',
      when,
      '',
      '数据不会被删除，您可以随时恢复订阅：',
      d.billingUrl,
    ].join('\n');

    const html = wrapEmailHtml([
      emailHeading('订阅', `${esc(d.shopName)}：订阅已取消`),
      `<p>${esc(when)}</p>`,
      '<p>数据不会被删除，您可以随时恢复订阅。</p>',
      emailButton(d.billingUrl, '恢复订阅'),
    ].join('\n'), { variant: 'owner', zh: true });

    return { subject: `${d.shopName}：订阅已取消`, html, text };
  }

  const ends = d.endsAtText ?? 'the end of the current billing period';
  const when = d.atPeriodEnd
    ? `Everything keeps working until the end of the current billing period (${ends}), `
      + 'after which this location becomes read-only.'
    : `The subscription ended on ${ends}; this location is now read-only.`;
  const text = [
    `${d.shopName}: subscription cancelled`,
    '',
    when,
    '',
    'Your data is kept. You can resubscribe at any time:',
    d.billingUrl,
  ].join('\n');

  const html = wrapEmailHtml([
    emailHeading('Billing', `${esc(d.shopName)}: subscription cancelled`),
    `<p>${esc(when)}</p>`,
    '<p>Your data is kept. You can resubscribe at any time.</p>',
    emailButton(d.billingUrl, 'Resubscribe'),
  ].join('\n'), { variant: 'owner' });

  return { subject: `${d.shopName}: subscription cancelled`, html, text };
}

// ═══════════════════════════════════════ 店主侧 · 订阅码即将到期 / 已到期

export interface LicenseExpiringData {
  shopName: string;
  /** 已按门店时区与店主语言格式化好的到期时刻 */
  endsAtText: string;
  /** 还剩几天。0 = 今天到期或已经到期 */
  daysLeft: number;
  locale: OwnerLocale;
}

/**
 * 订阅码到期提醒。
 *
 * ## ⚠️ 这封信里**没有任何自助续费链接**
 *
 * 这批客户恰恰是不走 Stripe 的那批（微信 / 支付宝 / 现金私下付款）。
 * 给他们一个「管理订阅」按钮会跳到一个他从来没有过的 Stripe 客户门户 ——
 * 而他点不动之后的下一步是打电话来问「你们的链接坏了」。
 *
 * 正确的下一步是**联系我们**，所以正文只说这一件事。
 *
 * ## 为什么正文不写「已付多少钱」
 *
 * 面值（`amount_cents`）是我们内部对账用的留档，而私下转账的金额可能
 * 含折扣、含代付、含好几家店。在信里复述一个我们没有凭据的数字，
 * 只会制造一次没必要的争执。
 */
export function renderLicenseExpiring(d: LicenseExpiringData): Rendered {
  if (isZhLocale(d.locale)) {
    const head = d.daysLeft > 0
      ? `${d.shopName}：服务将于 ${d.endsAtText} 到期`
      : `${d.shopName}：服务已到期`;
    const body = d.daysLeft > 0
      ? `您的服务有效期至 ${d.endsAtText}（还剩 ${d.daysLeft} 天）。`
        + '到期后门店转为只读：还能查看数据、导出报表，但开不了新单。'
      : `您的服务已于 ${d.endsAtText} 到期，门店当前为只读状态。`
        + '数据不会被删除，续期后立刻恢复。';
    const text = [head, '', body, '', '需要续期请联系 GenieFront 客服，我们会为您延长有效期。'].join('\n');
    const html = wrapEmailHtml([
      emailHeading('订阅', esc(head)),
      `<p>${esc(body)}</p>`,
      '<p>需要续期请联系 GenieFront 客服，我们会为您延长有效期。</p>',
    ].join('\n'), { variant: 'owner', zh: true });
    return { subject: head, html, text };
  }

  const head = d.daysLeft > 0
    ? `${d.shopName}: service ends on ${d.endsAtText}`
    : `${d.shopName}: service has ended`;
  const body = d.daysLeft > 0
    ? `Your service is active until ${d.endsAtText} (${d.daysLeft} days left). `
      + 'After that the location becomes read-only: you can still view and export '
      + 'your data, but you cannot open new tickets.'
    : `Your service ended on ${d.endsAtText} and this location is now read-only. `
      + 'Your data is kept and comes back the moment the term is extended.';
  const text = [head, '', body, '', 'To extend your term, contact GenieFront support.'].join('\n');
  const html = wrapEmailHtml([
    emailHeading('Billing', esc(head)),
    `<p>${esc(body)}</p>`,
    '<p>To extend your term, contact GenieFront support.</p>',
  ].join('\n'), { variant: 'owner' });
  return { subject: head, html, text };
}
