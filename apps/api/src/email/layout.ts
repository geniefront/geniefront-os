import { notificationCopy } from '../notify/copy';
import type { OwnerLocale } from './locale';
/**
 * 邮件 HTML 共用骨架。
 *
 * 路径 A（`render.ts` 硬编码）与路径 B（`notification_templates`）必须套
 * **同一套**品牌壳：薄荷顶条 + 水平 logo + 白卡片 + 页脚。
 *
 * 全部 table + 内联样式。`<style>` / class / SVG 在 Outlook 里会丢。
 * logo 必须是 PNG 的绝对 URL（`emailLogoUrl()`）。
 */

import { emailLogoUrl, marketingBaseUrl } from '../links';

export const EMAIL_BRAND = {
  mint: '#9BCDA3',
  mintLight: '#F2FAF3',
  charcoal: '#384341',
  muted: '#6B7A76',
  line: '#E4EBE5',
  white: '#FFFFFF',
  width: 600,
} as const;

/** 正文单元格的字体栈。测试与调用方用它识别「套了品牌壳」。 */
export const EMAIL_WRAP =
  `font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:16px;`
  + `line-height:1.7;color:${EMAIL_BRAND.charcoal}`;

export const EMAIL_MUTED = `color:${EMAIL_BRAND.muted};font-size:14px;line-height:1.6`;

export const EMAIL_BTN =
  `display:inline-block;background:${EMAIL_BRAND.charcoal};color:${EMAIL_BRAND.white};`
  + 'text-decoration:none;padding:14px 24px;border-radius:10px;font-weight:600;font-size:15px';

export type EmailShellOpts = {
  variant?: 'customer' | 'owner' | 'marketing';
  zh?: boolean;
  locale?: OwnerLocale;
  unsubscribeUrl?: string | null;
  preheader?: string;
};

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 转义后再把换行变成 `<br>`。营销模板是店主写的纯文本，只能靠这个排段落。 */
export function nl2brHtml(s: string): string {
  return escapeHtml(s).replace(/\n/g, '<br>');
}

export function emailButton(href: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:28px 0 8px"><tr><td>`
    + `<a href="${escapeHtml(href)}" style="${EMAIL_BTN}">${escapeHtml(label)}</a>`
    + `</td></tr></table>`;
}

export function emailHeading(eyebrow: string, titleHtml: string): string {
  return `<p style="margin:0 0 6px;font-size:11px;letter-spacing:0.12em;text-transform:uppercase;`
    + `color:${EMAIL_BRAND.muted};font-weight:600">${escapeHtml(eyebrow)}</p>`
    + `<p style="margin:0 0 20px;font-size:22px;line-height:1.35;color:${EMAIL_BRAND.charcoal};`
    + `font-weight:600">${titleHtml}</p>`;
}

export function emailDetailTable(rows: ReadonlyArray<readonly [string, string]>): string {
  const trs = rows.map(([k, v], i) => {
    const border = i === 0 ? '' : `border-top:1px solid ${EMAIL_BRAND.line};`;
    return `<tr>`
      + `<td style="padding:10px 16px;${border}color:${EMAIL_BRAND.muted};font-size:13px;width:38%">${escapeHtml(k)}</td>`
      + `<td style="padding:10px 16px;${border}color:${EMAIL_BRAND.charcoal};font-weight:600">${escapeHtml(v)}</td>`
      + `</tr>`;
  }).join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" `
    + `style="border-collapse:collapse;margin:8px 0 24px;background:${EMAIL_BRAND.mintLight};border-radius:10px">`
    + `${trs}</table>`;
}

function footerHtml(opts: EmailShellOpts): string {
  const zh = opts.zh === true;
  const unsub = opts.unsubscribeUrl
    ? (zh
        ? `不想再收到这类邮件？<a href="${escapeHtml(opts.unsubscribeUrl)}" style="color:${EMAIL_BRAND.muted};text-decoration:underline">退订</a>。`
        : `Don't want these emails? <a href="${escapeHtml(opts.unsubscribeUrl)}" style="color:${EMAIL_BRAND.muted};text-decoration:underline">Unsubscribe</a>.`)
    : '';
  const c = notificationCopy(opts.locale);
  const about = opts.locale ? (opts.variant === 'owner' ? c.billingFooter : c.footer) : opts.variant === 'owner'
    ? (zh ? 'GenieFront 账单通知。' : 'GenieFront billing notice.')
    : (zh ? '由 GenieFront 代门店发送。' : 'Sent by GenieFront for your salon.');
  return `<p style="margin:0;font-size:12px;line-height:1.6;color:${EMAIL_BRAND.muted}">`
    + `${about}${unsub ? `<br>${unsub}` : ''}<br>`
    + `<a href="${escapeHtml(marketingBaseUrl())}" style="color:${EMAIL_BRAND.muted};text-decoration:none">geniefront.com</a>`
    + `</p>`;
}

/**
 * 品牌壳：薄荷顶条、logo、白卡片、页脚。
 *
 * ⚠️ inner 必须已经转义。本函数不再转义，以便标题里保留 `<strong>`。
 */
export function wrapEmailHtml(inner: string, opts: EmailShellOpts = {}): string {
  const logo = emailLogoUrl();
  const home = marketingBaseUrl();
  const preheader = opts.preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">`
      + `${escapeHtml(opts.preheader)}</div>`
    : '';

  return `${preheader}`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${EMAIL_BRAND.mintLight};margin:0;padding:0">`
    + `<tr><td align="center" style="padding:24px 12px">`
    + `<table role="presentation" width="${EMAIL_BRAND.width}" cellpadding="0" cellspacing="0" `
    + `style="max-width:${EMAIL_BRAND.width}px;width:100%;background:${EMAIL_BRAND.white};border-radius:12px;overflow:hidden">`
    + `<tr><td style="height:4px;background:${EMAIL_BRAND.mint};font-size:0;line-height:0">&nbsp;</td></tr>`
    + `<tr><td style="padding:28px 40px 12px">`
    + `<a href="${escapeHtml(home)}" style="text-decoration:none">`
    + `<img src="${escapeHtml(logo)}" width="152" height="36" alt="GenieFront" `
    + `style="display:block;border:0;width:152px;height:36px"/>`
    + `</a></td></tr>`
    + `<tr><td style="padding:8px 40px 8px;${EMAIL_WRAP}">${inner}</td></tr>`
    + `<tr><td style="padding:12px 40px 32px">`
    + `<div style="border-top:1px solid ${EMAIL_BRAND.line};padding-top:20px">${footerHtml(opts)}</div>`
    + `</td></tr>`
    + `</table></td></tr></table>`;
}

/** 路径 B 事务性邮件：转义 + 换行 + 品牌壳。没有退订页脚。 */
export function renderTemplatedEmailHtml(body: string, action?: {url:string;label:string}, opts: EmailShellOpts = {}): string {
  return wrapEmailHtml(`<div>${nl2brHtml(body)}</div>` + (action ? emailButton(action.url, action.label) : ''), opts);
}

/**
 * 路径 B 营销邮件的 HTML / 纯文本。
 *
 * ⚠️ `body` 按纯文本处理：店主在编辑框里写下的任何字符都要转义。
 * 在 `renderTemplate` 里转义会让短信出现 `&amp;`，所以转义只发生在这里。
 */
export function renderMarketingEmail(
  body: string,
  unsubscribePageUrl: string,
): { html: string; text: string } {
  const text = `${body}\n\n---\nDon't want these emails? Unsubscribe: ${unsubscribePageUrl}`;
  const html = wrapEmailHtml(
    `<div>${nl2brHtml(body)}</div>`,
    { variant: 'marketing', unsubscribeUrl: unsubscribePageUrl },
  );
  return { html, text };
}
