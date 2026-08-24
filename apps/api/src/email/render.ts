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
}

export interface Rendered { subject: string; html: string; text: string; }

/**
 * 预约确认信。
 *
 * ⚠️ **不放取消/改期链接。** 那需要一个无登录的公开入口，
 * 而「捡到这个链接的人能干什么」的答案会是「改掉别人的预约」（`09` §5.2）。
 * 让客人打电话给店里 —— 这也正是店家想要的（有机会挽留）。
 *
 * ⭐ **公开预约上线后这一条依然成立**（2026-08-21，docs/13 §4.5）。
 * 官网订的单确实能自助取消，但那条路是：令牌只在**建单响应**里返回一次、
 * 交给官网自己决定要不要做「我的预约」页面。**信里一个字都没变** ——
 * 一封会被转发、会被同事看到的邮件，永远不该自带一个能改动预约的凭证。
 *
 * ⚠️ **不放客人的手机号**。信是发给他本人的，他知道自己的号码；
 * 而邮箱被转发、被同事看到是常事。
 */
export function renderConfirm(d: ConfirmData): Rendered {
  const who = d.staffName ? `技师：${d.staffName}` : '';
  const call = d.shopPhone ? `如需改期或取消，请致电 ${d.shopPhone}。` : '如需改期或取消，请致电门店。';

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
<p style="color:#6b635a;font-size:14px">${esc(call)}</p>
<p style="color:#6b635a;font-size:14px">— ${esc(d.shopName)}</p>
</div>`;

  return { subject: `预约已确认 · ${d.whenText} · ${d.shopName}`, html, text };
}

/**
 * 把 UTC 时间按门店时区排成人话。
 *
 * ⚠️ 一律走门店时区，**不是服务器时区也不是客人的**。
 * 客人看到的必须是「到店那一刻墙上的钟」—— 差一小时他就会白跑一趟。
 */
export function formatWhen(iso: string, timezone: string): string {
  const d = new Date(iso);
  const date = new Intl.DateTimeFormat('zh-CN', {
    timeZone: timezone, month: 'long', day: 'numeric', weekday: 'short',
  }).format(d);
  const time = new Intl.DateTimeFormat('zh-CN', {
    timeZone: timezone, hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(d);
  return `${date} ${time}`;
}
