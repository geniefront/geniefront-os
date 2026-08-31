/**
 * 发短信 —— Telnyx,纯 HTTP,不引 SDK(和 email/send.ts 同一个样子)。
 *
 * ⭐ **只在业务事务之外被调用**(`sms/flush.ts`)。
 *
 * ⚠️ 一条发不出去**永远不能阻断业务**。建单成功但确认短信没发出去,
 * 单还是要建成(宪法第 14 条)。宪法第 13 条(不许写短信依赖)被店主
 * 明确解除了,第 14 条没有。
 */

import { randomUUID } from 'node:crypto';
import { isCaptureMode } from '../comms/mode';

const ENDPOINT = 'https://api.telnyx.com/v2/messages';

export interface SmsResult {
  ok: boolean;
  providerId?: string;
  error?: string;
  /** 重试也没用(号码本身不对、被运营商永久拒收) */
  permanent?: boolean;
  /** capture 模式:**没有真的发出去**,只留在发件箱里供测试查看 */
  captured?: boolean;
}

/**
 * capture 模式和测试进程里也算「配好了」—— 否则 `flushSms()` 会在第一行
 * 就 return,发件箱里的短信永远停在 pending,测试收件箱是空的。
 */
export function smsConfigured(): boolean {
  if (isCaptureMode() || process.env['NODE_ENV'] === 'test') return true;
  return Boolean(process.env['TELNYX_API_KEY'] && process.env['TELNYX_SMS_FROM']);
}

/**
 * 发件号码。capture 模式下可能一个号都没配 —— 给一个显眼的占位值,
 * 免得测试收件箱里那一列是空白,让人以为是数据丢了。
 */
export const smsFrom = (): string => process.env['TELNYX_SMS_FROM']
  ?? (isCaptureMode() ? '+10000000000' : '');

export async function sendSms(msg: { to: string; text: string }): Promise<SmsResult> {
  /**
   * 🔴 **测试里一条都不许真发。**
   *
   * `.env` 在测试进程里是加载的（vitest.shared 的 loadEnv），所以
   * `smsConfigured()` 在测试里是 true —— 不拦的话，`public.test.ts` 每跑一遍
   * 就会往一批 `+1617555xxxx` 的随机号真发短信：**真花钱**，
   * 而且给运营商刷一批投递失败，10DLC 的号码信誉是会被这个拖垮的。
   *
   * 拦在这里而不是拦在 flush：这样入队、渲染、分段、计量那几步照常被测到，
   * 只有「真的打出去」这一下是假的。
   */
  if (process.env['NODE_ENV'] === 'test' || isCaptureMode()) {
    // captured ≠ sent:这条**没有真的发出去**。混成 sent 的话,
    // staging 上「发信成功率」这个数字会变成一个假的 100%
    return { ok: true, captured: true, providerId: `capture:${randomUUID()}` };
  }

  const key = process.env['TELNYX_API_KEY'];
  const from = process.env['TELNYX_SMS_FROM'];
  if (!key || !from) return { ok: false, error: 'not_configured' };

  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: msg.to, text: msg.text }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'network' };
  }

  if (res.ok) {
    const body = await res.json().catch(() => ({})) as { data?: { id?: string } };
    const id = body.data?.id;
    return { ok: true, ...(id ? { providerId: id } : {}) };
  }

  const detail = await res.text().catch(() => '');
  /**
   * 4xx 重试没有意义,除了 429。
   *
   * ⚠️ 这里最常见的 4xx 是**号码不能收短信**(座机、VoIP 被拒)——
   * 不标成永久失败的话,一个座机号会在每次补发里都重试一遍,永远占着队首。
   */
  return {
    ok: false,
    error: `${res.status} ${detail.slice(0, 200)}`,
    permanent: res.status >= 400 && res.status < 500 && res.status !== 429,
  };
}
