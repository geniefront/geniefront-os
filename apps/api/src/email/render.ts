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
}

export interface Rendered { subject: string; html: string; text: string; }

/**
 * 预约确认信。
 *
 * ## 关于那个自助管理链接（这一段是两次决定的完整记录，别删）
 *
 * **初版（2026-08-21）不放链接**，理由是：一封会被转发、会被同事看到的邮件，
 * 不该自带一个能改动预约的凭证。「捡到这个链接的人能干什么」的答案是
 * 「改掉别人的预约」——不好听。当时的做法是令牌只在**建单响应**里返回一次，
 * 交给官网自己决定要不要做「我的预约」页面。
 *
 * **批 2（2026-08-25）改成放**，因为那个凭证不再是单因素：
 * 链接打开之后还要输**手机后四位**才动得了（`public/routes.ts` §assertLast4，
 * 连错三次锁 15 分钟）。捡到链接的同事没有那四位数。
 * 而不放链接的代价是真实的 —— 客人改不了就只剩「取消」或者「不来」，
 * 而 no-show 比改期糟得多：那一格既没人用、也收不到钱、技师还白等。
 *
 * ⚠️ **`manageUrl` 为 null 时一个字都不提。** 没留手机号的单验不了后四位，
 * 那时令牌就又变回单因素了 —— 调用方负责在那种情况下传 null。
 *
 * ⚠️ **不放客人的手机号**。信是发给他本人的，他知道自己的号码；
 * 而邮箱被转发、被同事看到是常事。
 */
export function renderConfirm(d: ConfirmData): Rendered {
  const who = d.staffName ? `技师：${d.staffName}` : '';
  // 有链接就先说链接，电话作为兜底跟在后面 —— 反过来的话，
  // 大部分人看到电话就不往下看了，链接白放
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

/**
 * 「到店前把健康表填了」的邀请信（`docs/15` §4）。
 *
 * ## ⚠️ 这封信里有一个能干事的链接，而上面那封刻意没有
 *
 * 看起来自相矛盾，其实是同一条标准算出来的两个答案：**捡到它的人能干什么。**
 *
 *   · 确认信里的取消链接 → 捡到的人能**改掉别人的预约**（不可接受）
 *   · 这封信里的填表链接 → 捡到的人能**替别人填一份健康表**
 *
 * 后者当然也不好，所以三道一起上：只活 72 小时、**填完立刻失效**、
 * 而且填出来的东西前台一眼看得出是链接来的（`source='link'`）。
 * 更关键的是反过来算一遍：不发这封信，客人就得在柜台前、后面排着队的时候
 * 用一台公用 iPad 回答「有没有血栓史」—— 那种情况下他会一路点「否」，
 * 而这张表的全部意义就在他答的是不是真话。
 *
 * ⚠️ **信里不写他填过什么、也不写他的手机号。** 邮箱被转发是常事。
 */
export interface FormInviteData {
  customerName: string;
  shopName: string;
  /** 要签的表叫什么（已经按客人语言取好） */
  formTitles: string[];
  url: string;
  /** 已按门店时区格式化好的失效时间 */
  expiresText: string;
  shopPhone: string | null;
}

export function renderFormInvite(d: FormInviteData): Rendered {
  const list = d.formTitles.join('、');
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

// ─────────────────────────────────────────────────────── 试用还有 3 天到期

export interface TrialEndingData {
  shopName: string;
  /** 已经按门店时区格式化好的首次扣款日，如「9月1日 周二」 */
  chargeDateText: string;
  planLabel: string;
  monthlyText: string;
  /** 老板自助管理订阅的入口（Stripe Customer Portal 的落地页） */
  billingUrl: string;
}

/**
 * 试用到期前 3 天的提醒信（批 1）。
 *
 * ⚠️ **必须把三件事写在一起**：哪天扣、扣多少、去哪儿取消。
 * 少了任何一件，这封信就变成了「我们要扣你钱了」而不是通知 ——
 * 而一封说不清怎么取消的催款信，收到的人第一反应是找银行拒付，
 * 那比退订贵得多（拒付会留在我们的商户记录上）。
 *
 * ⚠️ **不写「您的试用即将结束，请立即升级」这种话术。** 他已经绑了卡，
 * 什么都不做就会自动续 —— 假装需要他行动是在制造不存在的紧迫感。
 */
export function renderTrialEnding(d: TrialEndingData): Rendered {
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
