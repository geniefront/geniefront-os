/**
 * 发邮件 —— Resend，纯 HTTP，不引 SDK。
 *
 * ⭐ **这个模块只在业务事务之外被调用**（`email/flush.ts` 的长注释）。
 *
 * ⚠️ 一封发不出去**永远不能阻断业务**。建单成功但确认信没发出去，
 * 单还是要建成 —— 最坏情况是前台打个电话。反过来（因为邮件挂了
 * 把单也回滚掉）是荒谬的（宪法第 14 条：增强项永不成为阻断点）。
 */

import { randomUUID } from 'node:crypto';
import { isCaptureMode, mailpitEndpoint } from '../comms/mode';

const ENDPOINT = 'https://api.resend.com/emails';

export interface SendResult {
  ok: boolean;
  providerId?: string;
  error?: string;
  /** 这一封是不是**重试也没用**（地址本身是错的） */
  permanent?: boolean;
  /** capture 模式：**没有真的发出去**，只留在发件箱里供测试查看 */
  captured?: boolean;
}

/**
 * capture 模式和测试进程里也算「配好了」—— 否则 `flushEmails()` 会在
 * 第一行就 return，发件箱里的信永远停在 pending，测试收件箱是空的，
 * 而这一页存在的意义正是让人看见这些信。
 */
export function emailConfigured(): boolean {
  if (isCaptureMode() || process.env['NODE_ENV'] === 'test') return true;
  return Boolean(process.env['RESEND_API_KEY'] && process.env['FROM_EMAIL']);
}

/**
 * capture：不出网，只回一个本地凭证。
 *
 * 顺手往本机 Mailpit 投一份（配了 `MAILPIT_URL` 才投），这样本地开发能在
 * 一个真的邮件客户端里看排版和链接。**投不投得进去都不影响结果** ——
 * 发件箱里那一整封才是凭据，Mailpit 只是个方便看的窗口。
 */
async function captureEmail(msg: OutgoingEmail): Promise<SendResult> {
  const endpoint = mailpitEndpoint();
  if (endpoint) {
    try {
      await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          From: { Email: 'capture@geniefront.test', Name: 'GenieFront capture' },
          To: [{ Email: msg.to }],
          Subject: msg.subject,
          HTML: msg.html,
          Text: msg.text,
        }),
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      // 本机没开 Mailpit 是常态，不值得留痕
    }
  }
  return { ok: true, captured: true, providerId: `capture:${randomUUID()}` };
}

export interface OutgoingEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
  /**
   * 一键退订地址（RFC 8058）。**仅营销类邮件有值**。
   *
   * 有值时写两个头：`List-Unsubscribe` 指向该地址，`List-Unsubscribe-Post`
   * 声明其支持一键退订。缺了后一个，Gmail 与 Outlook 不会在界面上显示
   * 「取消订阅」按钮 —— 收件人于是只能点「举报垃圾邮件」，而那会直接
   * 损害发信域名的信誉。
   */
  unsubscribeUrl?: string | null;
  /**
   * 覆盖发件地址。**仅营销邮件有值**（门店自己的
   * `marketing_email_from`，须已在 Resend 完成域名验证）。
   *
   * ⚠️ 事务性邮件一律用平台的 `FROM_EMAIL`。用平台域名群发商业邮件，
   * 投诉率与退信率会算到平台头上 —— 一家店的营销邮件被举报，受损的是
   * 所有门店事务性邮件的送达率。
   */
  from?: string | null;
}

export async function sendEmail(msg: OutgoingEmail): Promise<SendResult> {
  /**
   * 🔴 **capture 模式与测试进程里一封都不许真发。**
   *
   * `.env` 在测试进程里是加载的（vitest.shared 的 loadEnv），所以
   * `RESEND_API_KEY` 在测试里是有值的 —— 不拦的话，每跑一遍测试就往
   * 一批 `@example.test` 的地址真发一批信：烧配额，而且投递失败率会
   * 拖垮 `mail.geniefront.com` 这个域的发信信誉。
   *
   * 拦在这里而不是拦在 flush：入队、渲染、去重、重试计数那几步照常被测到，
   * 只有「真的打出去」这一下是假的（和 `sms/send.ts` 同一条纪律）。
   */
  if (isCaptureMode() || process.env['NODE_ENV'] === 'test') return captureEmail(msg);

  const key = process.env['RESEND_API_KEY'];
  const from = process.env['FROM_EMAIL'];
  if (!key || !from) return { ok: false, error: 'not_configured' };

  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: msg.from || from,
        to: [msg.to], subject: msg.subject, html: msg.html, text: msg.text,
        ...(msg.unsubscribeUrl
          ? {
              headers: {
                'List-Unsubscribe': `<${msg.unsubscribeUrl}>`,
                'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
              },
            }
          : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    // 网络层挂了 —— 下次再试
    return { ok: false, error: e instanceof Error ? e.message : 'network' };
  }

  if (res.ok) {
    const body = await res.json().catch(() => ({})) as { id?: string };
    return { ok: true, ...(body.id ? { providerId: body.id } : {}) };
  }

  const detail = await res.text().catch(() => '');
  // ⭐ 4xx（地址不合法、域名没验证）**重试多少次都一样**。
  // 不把它标成永久失败的话，一个打错的邮箱会让这封信在每次
  // 补发扫描里都重试一遍，永远占着队首。
  return {
    ok: false,
    error: `${res.status} ${detail.slice(0, 200)}`,
    permanent: res.status >= 400 && res.status < 500 && res.status !== 429,
  };
}
