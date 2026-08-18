/**
 * 发邮件 —— Resend，纯 HTTP，不引 SDK。
 *
 * ⭐ **这个模块只在业务事务之外被调用**（`email/flush.ts` 的长注释）。
 *
 * ⚠️ 一封发不出去**永远不能阻断业务**。建单成功但确认信没发出去，
 * 单还是要建成 —— 最坏情况是前台打个电话。反过来（因为邮件挂了
 * 把单也回滚掉）是荒谬的（宪法第 14 条：增强项永不成为阻断点）。
 */

const ENDPOINT = 'https://api.resend.com/emails';

export interface SendResult {
  ok: boolean;
  providerId?: string;
  error?: string;
  /** 这一封是不是**重试也没用**（地址本身是错的） */
  permanent?: boolean;
}

export function emailConfigured(): boolean {
  return Boolean(process.env['RESEND_API_KEY'] && process.env['FROM_EMAIL']);
}

export async function sendEmail(msg: {
  to: string; subject: string; html: string; text: string;
}): Promise<SendResult> {
  const key = process.env['RESEND_API_KEY'];
  const from = process.env['FROM_EMAIL'];
  if (!key || !from) return { ok: false, error: 'not_configured' };

  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from, to: [msg.to], subject: msg.subject, html: msg.html, text: msg.text,
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
